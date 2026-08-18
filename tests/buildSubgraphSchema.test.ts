import { describe, expect, it } from 'vitest';
import { graphql, parse, validateSchema, GraphQLObjectType } from 'graphql';
import { buildSubgraphSchema } from '../src/index.js';

const productSDL = /* GraphQL */ `
  type Query {
    productById(id: ID!): Product @lookup
    productBySku(sku: String! @is(field: "sku")): Product @lookup
    products: [Product!]!
  }

  type Product @key(fields: "id") @key(fields: "sku") {
    id: ID!
    sku: String!
    name: String!
    dimension: ProductDimension @shareable
  }

  type ProductDimension {
    size: String
    weight: Float
  }
`;

const products = [
  { id: '1', sku: 'A-1', name: 'Chair', dimension: { size: 'L', weight: 10 } },
  { id: '2', sku: 'B-2', name: 'Table', dimension: { size: 'XL', weight: 42 } },
];

const productResolvers = {
  Query: {
    productById: (_root: unknown, args: { id: string }) =>
      products.find((product) => product.id === args.id),
    productBySku: (_root: unknown, args: { sku: string }) =>
      products.find((product) => product.sku === args.sku),
    products: () => products,
  },
};

describe('buildSubgraphSchema', () => {
  it('lets typeDefs use federation directives without defining them', () => {
    const schema = buildSubgraphSchema({ typeDefs: productSDL });
    expect(validateSchema(schema)).toEqual([]);

    const product = schema.getType('Product') as GraphQLObjectType;
    const keys = product.astNode?.directives?.filter((d) => d.name.value === 'key');
    expect(keys).toHaveLength(2);
    expect(schema.getDirective('key')).toBeDefined();
    expect(schema.getDirective('lookup')).toBeDefined();
    expect(schema.getType('FieldSelectionMap')).toBeDefined();
    expect(schema.getType('FieldSelectionSet')).toBeDefined();
  });

  it('supports every spec directive incl. the provisional ones from PR #233', () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          mediaById(id: ID!): Media @lookup
          productById(id: ID!): Product @lookup @internal
          legacyName: String @override(from: "LegacySchema") @inaccessible
        }

        interface Media @key(fields: "id") {
          id: ID!
        }

        "Stand-in for an interface owned by another source schema."
        type Video @interfaceObject @key(fields: "id") {
          id: ID!
          duration: Int @shareable
        }

        type Product @key(fields: "id") {
          id: ID!
          name: String! @implement
          size: String @external
          shippingEstimate(weight: Float @require(field: "weight")): Float
          dimension: ProductDimension @provides(fields: "size")
        }

        type ProductDimension {
          size: String @external
          weight: Float
        }
      `,
    });
    expect(validateSchema(schema)).toEqual([]);
  });

  it('executes queries with regular resolvers (no reference resolvers needed)', async () => {
    const schema = buildSubgraphSchema({
      typeDefs: productSDL,
      resolvers: productResolvers,
    });

    const result = await graphql({
      schema,
      source: '{ productById(id: "1") { id name } productBySku(sku: "B-2") { name } }',
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      productById: { id: '1', name: 'Chair' },
      productBySku: { name: 'Table' },
    });
  });

  it('accepts DocumentNode and nested array typeDefs', () => {
    const schema = buildSubgraphSchema({
      typeDefs: [
        parse('type Query { productById(id: ID!): Product @lookup }'),
        ['type Product @key(fields: "id") { id: ID! }'],
      ],
    });
    expect(validateSchema(schema)).toEqual([]);
    expect((schema.getType('Product') as GraphQLObjectType).getFields().id).toBeDefined();
  });

  it('rejects unsupported typeDefs values', () => {
    expect(() =>
      buildSubgraphSchema({ typeDefs: 42 as unknown as string }),
    ).toThrow(TypeError);
  });

  it('keeps user-provided federation definitions instead of duplicating them', () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        scalar FieldSelectionSet

        directive @key(fields: FieldSelectionSet!, futureArg: String) repeatable on OBJECT | INTERFACE

        type Query {
          productById(id: ID!): Product @lookup
        }

        type Product @key(fields: "id", futureArg: "x") {
          id: ID!
        }
      `,
    });

    expect(validateSchema(schema)).toEqual([]);
    const key = schema.getDirective('key');
    expect(key?.args.map((arg) => arg.name)).toEqual(['fields', 'futureArg']);
  });

  it('supports extend type Query without a base definition', async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        extend type Query {
          productById(id: ID!): Product @lookup
        }

        type Product @key(fields: "id") {
          id: ID!
        }
      `,
      resolvers: {
        Query: {
          productById: (_root: unknown, args: { id: string }) => ({ id: args.id }),
        },
      },
    });

    expect(validateSchema(schema)).toEqual([]);
    const result = await graphql({ schema, source: '{ productById(id: "7") { id } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ productById: { id: '7' } });
  });

  it('merges multiple baseless extensions of the same type', () => {
    const schema = buildSubgraphSchema({
      typeDefs: [
        'extend type Query { a: String }',
        'extend type Query { b: String }',
      ],
    });

    expect(validateSchema(schema)).toEqual([]);
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(['a', 'b']);
  });

  it('leaves extensions with a base type as extensions', () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          productById(id: ID!): Product @lookup
        }

        type Product {
          id: ID!
        }

        extend type Product @key(fields: "id") {
          name: String
        }
      `,
    });

    expect(validateSchema(schema)).toEqual([]);
    const product = schema.getType('Product') as GraphQLObjectType;
    expect(Object.keys(product.getFields())).toEqual(['id', 'name']);
  });

  it('validates SDL against the injected definitions', () => {
    expect(() =>
      buildSubgraphSchema({
        typeDefs: /* GraphQL */ `
          type Query {
            field: String @key(fields: "id")
          }
        `,
      }),
    ).toThrow(/@key/);
  });
});
