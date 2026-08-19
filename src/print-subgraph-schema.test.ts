import { describe, expect, it } from 'vitest';
import { buildSchema, validateSchema } from 'graphql';
import { buildSubgraphSchema, printSubgraphSchema } from './index.js';

const sdl = /* GraphQL */ `
  type Query {
    productById(id: ID!): Product @lookup
    productBySku(sku: String! @is(field: "sku")): Product @lookup @internal
  }

  type Product @key(fields: "id") @key(fields: "sku") {
    id: ID!
    sku: String!
    name: String! @shareable
    hidden: String @inaccessible
  }
`;

describe('printSubgraphSchema', () => {
  it('prints applied federation directives', () => {
    const output = printSubgraphSchema(buildSubgraphSchema({ typeDefs: sdl }));

    expect(output).toContain('@key(fields: "id")');
    expect(output).toContain('@key(fields: "sku")');
    expect(output).toContain('@lookup');
    expect(output).toContain('@internal');
    expect(output).toContain('@is(field: "sku")');
    expect(output).toContain('@shareable');
    expect(output).toContain('@inaccessible');
  });

  it('omits the federation definitions by default', () => {
    const output = printSubgraphSchema(buildSubgraphSchema({ typeDefs: sdl }));

    expect(output).not.toContain('directive @');
    expect(output).not.toContain('scalar FieldSelectionMap');
    expect(output).not.toContain('scalar FieldSelectionSet');
  });

  it('round-trips through buildSubgraphSchema', () => {
    const output = printSubgraphSchema(buildSubgraphSchema({ typeDefs: sdl }));
    const rebuilt = buildSubgraphSchema({ typeDefs: output });

    expect(validateSchema(rebuilt)).toEqual([]);
    expect(printSubgraphSchema(rebuilt)).toEqual(output);
  });

  it('produces self-contained SDL with includeFederationDefinitions', () => {
    const output = printSubgraphSchema(buildSubgraphSchema({ typeDefs: sdl }), {
      includeFederationDefinitions: true,
    });

    expect(output).toContain(
      'directive @key(fields: FieldSelectionSet!) repeatable on OBJECT | INTERFACE',
    );
    expect(output).toContain('scalar FieldSelectionMap');

    const standalone = buildSchema(output);
    expect(validateSchema(standalone)).toEqual([]);
  });

  it('omits the schema block for default root type names, keeps custom ones', () => {
    const output = printSubgraphSchema(buildSubgraphSchema({ typeDefs: sdl }));
    expect(output).not.toContain('schema {');

    const custom = printSubgraphSchema(
      buildSubgraphSchema({
        typeDefs: /* GraphQL */ `
          schema {
            query: QueryRoot
          }

          type QueryRoot {
            productById(id: ID!): Product @lookup
          }

          type Product @key(fields: "id") {
            id: ID!
          }
        `,
      }),
    );
    expect(custom).toContain('schema {');
    expect(custom).toContain('query: QueryRoot');
  });

  it('keeps user-customized federation-named definitions and round-trips them', () => {
    const output = printSubgraphSchema(
      buildSubgraphSchema({
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
      }),
    );

    expect(output).toContain(
      'directive @key(fields: FieldSelectionSet!, futureArg: String) repeatable on OBJECT | INTERFACE',
    );
    expect(output).toContain('@key(fields: "id", futureArg: "x")');
    // The user's FieldSelectionSet copy matches the spec, so it is still omitted.
    expect(output).not.toContain('scalar FieldSelectionSet');

    const rebuilt = buildSubgraphSchema({ typeDefs: output });
    expect(validateSchema(rebuilt)).toEqual([]);
    expect(rebuilt.getDirective('key')?.args.map((arg) => arg.name)).toEqual([
      'fields',
      'futureArg',
    ]);
    expect(printSubgraphSchema(rebuilt)).toEqual(output);
  });

  it('still omits user-supplied exact copies of spec definitions', () => {
    const output = printSubgraphSchema(
      buildSubgraphSchema({
        typeDefs: /* GraphQL */ `
          directive @lookup on FIELD_DEFINITION

          type Query {
            userById(id: ID!): User @lookup
          }

          type User @key(fields: "id") {
            id: ID!
          }
        `,
      }),
    );

    expect(output).not.toContain('directive @lookup');
    expect(output).toContain('@lookup');
  });

  it('keeps non-federation custom directives and their definitions', () => {
    const output = printSubgraphSchema(
      buildSubgraphSchema({
        typeDefs: /* GraphQL */ `
          directive @mine on FIELD_DEFINITION

          type Query {
            productById(id: ID!): Product @lookup @mine
          }

          type Product @key(fields: "id") {
            id: ID!
          }
        `,
      }),
    );

    expect(output).toContain('directive @mine on FIELD_DEFINITION');
    expect(output).toContain('@mine');
    expect(output).not.toContain('directive @lookup');
  });
});
