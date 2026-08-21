import {
  graphql,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLScalarType,
  parse,
  subscribe,
  validateSchema,
  type StringValueNode,
} from "graphql";
import { describe, expect, it } from "vitest";
import {
  buildSubgraphSchema,
  federationTypeDefsSDL,
  printSubgraphSchema,
} from "./index.js";

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
  { id: "1", sku: "A-1", name: "Chair", dimension: { size: "L", weight: 10 } },
  { id: "2", sku: "B-2", name: "Table", dimension: { size: "XL", weight: 42 } },
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

describe("buildSubgraphSchema", () => {
  it("lets typeDefs use federation directives without defining them", () => {
    const schema = buildSubgraphSchema({ typeDefs: productSDL });
    expect(validateSchema(schema)).toEqual([]);

    const product = schema.getType("Product") as GraphQLObjectType;
    const keys = product.astNode?.directives?.filter(
      (d) => d.name.value === "key",
    );
    expect(keys).toHaveLength(2);
    expect(schema.getDirective("key")).toBeDefined();
    expect(schema.getDirective("lookup")).toBeDefined();
    expect(schema.getType("FieldSelectionMap")).toBeDefined();
    expect(schema.getType("FieldSelectionSet")).toBeDefined();
  });

  it("supports every spec directive incl. the provisional ones from PR #233", () => {
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

  it("executes queries with regular resolvers (no reference resolvers needed)", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: productSDL,
      resolvers: productResolvers,
    });

    const result = await graphql({
      schema,
      source:
        '{ productById(id: "1") { id name } productBySku(sku: "B-2") { name } }',
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      productById: { id: "1", name: "Chair" },
      productBySku: { name: "Table" },
    });
  });

  it("accepts DocumentNode and nested array typeDefs", () => {
    const schema = buildSubgraphSchema({
      typeDefs: [
        parse("type Query { productById(id: ID!): Product @lookup }"),
        ['type Product @key(fields: "id") { id: ID! }'],
      ],
    });
    expect(validateSchema(schema)).toEqual([]);
    expect(
      (schema.getType("Product") as GraphQLObjectType).getFields().id,
    ).toBeDefined();
  });

  it("rejects unsupported typeDefs values", () => {
    expect(() =>
      buildSubgraphSchema({ typeDefs: 42 as unknown as string }),
    ).toThrow(TypeError);
  });

  it("keeps user-provided federation definitions instead of duplicating them", () => {
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
    const key = schema.getDirective("key");
    expect(key?.args.map((arg) => arg.name)).toEqual(["fields", "futureArg"]);
  });

  it("supports extend type Query without a base definition", async () => {
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
          productById: (_root: unknown, args: { id: string }) => ({
            id: args.id,
          }),
        },
      },
    });

    expect(validateSchema(schema)).toEqual([]);
    const result = await graphql({
      schema,
      source: '{ productById(id: "7") { id } }',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ productById: { id: "7" } });
  });

  it("merges multiple baseless extensions of the same type", () => {
    const schema = buildSubgraphSchema({
      typeDefs: [
        "extend type Query { a: String }",
        "extend type Query { b: String }",
      ],
    });

    expect(validateSchema(schema)).toEqual([]);
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(["a", "b"]);
  });

  it("leaves extensions with a base type as extensions", () => {
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
    const product = schema.getType("Product") as GraphQLObjectType;
    expect(Object.keys(product.getFields())).toEqual(["id", "name"]);
  });

  it("validates SDL against the injected definitions", () => {
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

  it("applies custom scalar resolvers from a config object", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        scalar UpperCase

        type Query {
          echo(value: UpperCase): UpperCase
        }
      `,
      resolvers: {
        UpperCase: {
          serialize: (value: unknown) => String(value).toUpperCase(),
          parseValue: (value: unknown) => String(value).toLowerCase(),
          parseLiteral: (node: unknown) =>
            (node as StringValueNode).value.toLowerCase(),
        },
        Query: {
          echo: (_root: unknown, args: { value: string }) => args.value,
        },
      },
    });

    const literal = await graphql({ schema, source: '{ echo(value: "AbC") }' });
    expect(literal.errors).toBeUndefined();
    // parseLiteral lowercases on the way in, serialize uppercases on the way
    // out — proving both directions ran.
    expect(literal.data).toEqual({ echo: "ABC" });

    const variable = await graphql({
      schema,
      source: "query ($value: UpperCase) { echo(value: $value) }",
      variableValues: { value: "DeF" },
    });
    expect(variable.errors).toBeUndefined();
    expect(variable.data).toEqual({ echo: "DEF" });
  });

  it("applies custom scalar resolvers from a GraphQLScalarType instance", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        scalar UpperCase

        type Query {
          shout: UpperCase
        }
      `,
      resolvers: {
        UpperCase: new GraphQLScalarType({
          name: "UpperCase",
          serialize: (value) => String(value).toUpperCase(),
        }),
        Query: { shout: () => "quiet" },
      },
    });

    const result = await graphql({ schema, source: "{ shout }" });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ shout: "QUIET" });
  });

  it("maps enum internal values in outputs, literals, variables, and defaults", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        enum Color {
          RED
          GREEN
        }

        type Query {
          favorite: Color
          internalOf(color: Color = RED): String
        }
      `,
      resolvers: {
        Color: { RED: "#f00", GREEN: "#0f0" },
        Query: {
          favorite: () => "#0f0",
          internalOf: (_root: unknown, args: { color: string }) => args.color,
        },
      },
    });

    const result = await graphql({
      schema,
      source: /* GraphQL */ `
        query ($color: Color) {
          favorite
          fromLiteral: internalOf(color: GREEN)
          fromVariable: internalOf(color: $color)
          fromDefault: internalOf
        }
      `,
      variableValues: { color: "RED" },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      favorite: "GREEN",
      fromLiteral: "#0f0",
      fromVariable: "#f00",
      fromDefault: "#f00",
    });
  });

  it("keeps applied directives printable after enum value mapping", () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        enum Color {
          RED
        }

        type Query {
          productById(id: ID!): Product @lookup
        }

        type Product @key(fields: "id") {
          id: ID!
          color: Color
        }
      `,
      resolvers: { Color: { RED: "#f00" } },
    });

    const output = printSubgraphSchema(schema);
    expect(output).toContain('type Product @key(fields: "id")');
    expect(output).toContain("@lookup");
  });

  it("supports __resolveType on interfaces and __isTypeOf on objects", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        interface Media {
          id: ID!
        }

        type Book implements Media {
          id: ID!
          title: String
        }

        union Furniture = Chair | Table

        type Chair {
          legs: Int
        }

        type Table {
          seats: Int
        }

        type Query {
          media: Media
          furniture: Furniture
        }
      `,
      resolvers: {
        Media: { __resolveType: () => "Book" },
        Chair: {
          __isTypeOf: (source: { legs?: number }) => source.legs !== undefined,
        },
        Table: {
          __isTypeOf: (source: { seats?: number }) =>
            source.seats !== undefined,
        },
        Query: {
          media: () => ({ id: "1", title: "Dune" }),
          furniture: () => ({ legs: 4 }),
        },
      },
    });

    const result = await graphql({
      schema,
      source: /* GraphQL */ `
        {
          media {
            id
            ... on Book {
              title
            }
          }
          furniture {
            ... on Chair {
              legs
            }
            ... on Table {
              seats
            }
          }
        }
      `,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      media: { id: "1", title: "Dune" },
      furniture: { legs: 4 },
    });
  });

  it("supports __resolveType on unions", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        union Result = Success

        type Success {
          ok: Boolean
        }

        type Query {
          attempt: Result
        }
      `,
      resolvers: {
        Result: { __resolveType: () => "Success" },
        Query: { attempt: () => ({ ok: true }) },
      },
    });

    const result = await graphql({
      schema,
      source: "{ attempt { ... on Success { ok } } }",
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ attempt: { ok: true } });
  });

  it("supports subscribe resolvers", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          ok: Boolean
        }

        type Subscription {
          ticks: Int
        }
      `,
      resolvers: {
        Subscription: {
          ticks: {
            // eslint-disable-next-line @typescript-eslint/require-await
            subscribe: async function* () {
              yield { ticks: 1 };
              yield { ticks: 2 };
            },
          },
        },
      },
    });

    const iterator = (await subscribe({
      schema,
      document: parse("subscription { ticks }"),
    })) as AsyncIterableIterator<{ data?: unknown }>;

    const received: unknown[] = [];

    for await (const payload of iterator) {
      received.push(payload.data);
    }

    expect(received).toEqual([{ ticks: 1 }, { ticks: 2 }]);
  });

  it("merges an array of resolver maps", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: "type Query { a: String, b: String }",
      resolvers: [{ Query: { a: () => "a" } }, { Query: { b: () => "b" } }],
    });

    const result = await graphql({ schema, source: "{ a b }" });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ a: "a", b: "b" });
  });

  it("rejects resolvers the schema has no matching member for", () => {
    const typeDefs = /* GraphQL */ `
      enum Color {
        RED
      }

      input Filter {
        text: String
      }

      type Query {
        color(filter: Filter): Color
      }
    `;

    expect(() =>
      buildSubgraphSchema({ typeDefs, resolvers: { Missing: {} } }),
    ).toThrow(/"Missing"/);
    expect(() =>
      buildSubgraphSchema({
        typeDefs,
        resolvers: { Query: { missing: () => null } },
      }),
    ).toThrow(/"Query\.missing"/);
    expect(() =>
      buildSubgraphSchema({
        typeDefs,
        resolvers: { Color: { BLUE: "#00f" } },
      }),
    ).toThrow(/"Color\.BLUE"/);
    expect(() =>
      buildSubgraphSchema({
        typeDefs,
        resolvers: { Filter: { text: () => "" } },
      }),
    ).toThrow(/input object/);
    expect(() =>
      buildSubgraphSchema({
        typeDefs,
        resolvers: { String: { serialize: (value: unknown) => value } },
      }),
    ).toThrow(/built-in scalar/);
  });

  it("rejects Apollo Federation reference resolvers with @lookup guidance", () => {
    const typeDefs = /* GraphQL */ `
      union Entity = User

      type Query {
        user: User
      }

      type User {
        id: ID!
      }
    `;

    expect(() =>
      buildSubgraphSchema({
        typeDefs,
        resolvers: { User: { __resolveReference: () => ({ id: "1" }) } },
      }),
    ).toThrow(/Apollo Federation.*@lookup/);
    expect(() =>
      buildSubgraphSchema({
        typeDefs,
        resolvers: { Entity: { __resolveReference: () => ({ id: "1" }) } },
      }),
    ).toThrow(/Apollo Federation.*@lookup/);
  });

  it("rejects misplaced or unknown special resolver entries", () => {
    const typeDefs = /* GraphQL */ `
      interface Node {
        id: ID!
      }

      type Query implements Node {
        id: ID!
      }
    `;

    expect(() =>
      buildSubgraphSchema({
        typeDefs,
        resolvers: { Query: { __resolveType: () => "Query" } },
      }),
    ).toThrow(/__resolveType.*only valid on interface and union/);
    expect(() =>
      buildSubgraphSchema({
        typeDefs,
        resolvers: { Node: { __isTypeOf: () => true } },
      }),
    ).toThrow(/__isTypeOf.*only valid on object/);
    expect(() =>
      buildSubgraphSchema({
        typeDefs,
        resolvers: { Query: { __resolveTypo: () => "Query" } },
      }),
    ).toThrow(/not a supported resolver entry/);
  });

  it("rejects unknown options loudly", () => {
    expect(() =>
      buildSubgraphSchema({
        typeDefs: "type Query { a: String }",
        // @ts-expect-error -- intentionally passing a removed makeExecutableSchema option
        resolverValidationOptions: { requireResolversToMatchSchema: "ignore" },
      }),
    ).toThrow(/unknown option "resolverValidationOptions"/);
  });

  it("applies parseValue to inline literals when parseLiteral is not given", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        scalar Lower

        type Query {
          echo(value: Lower): String
        }
      `,
      resolvers: {
        Lower: { parseValue: (value: unknown) => String(value).toLowerCase() },
        Query: {
          echo: (_root: unknown, args: { value: string }) => args.value,
        },
      },
    });

    // graphql-js derives the default parseLiteral from parseValue only at
    // construction time; the derived literal parser must route through the
    // attached parseValue so literals and variables agree.
    const literal = await graphql({ schema, source: '{ echo(value: "AbC") }' });
    expect(literal.errors).toBeUndefined();
    expect(literal.data).toEqual({ echo: "abc" });

    const variable = await graphql({
      schema,
      source: "query ($value: Lower) { echo(value: $value) }",
      variableValues: { value: "DeF" },
    });
    expect(variable.errors).toBeUndefined();
    expect(variable.data).toEqual({ echo: "def" });
  });

  it("re-coerces SDL default values through attached scalar parsers", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        scalar Upper

        input Filter {
          text: Upper = "abc"
        }

        type Query {
          echo(value: Upper = "abc", filter: Filter = { text: "def" }): String
        }
      `,
      resolvers: {
        Upper: { parseValue: (value: unknown) => String(value).toUpperCase() },
        Query: {
          echo: (
            _root: unknown,
            args: { value: string; filter: { text: string } },
          ) => `${args.value}/${args.filter.text}`,
        },
      },
    });

    const result = await graphql({ schema, source: "{ echo }" });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ echo: "ABC/DEF" });
  });

  it("copies description and specifiedByURL from scalar instances", () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        scalar DateTime

        type Query {
          now: DateTime
        }
      `,
      resolvers: {
        DateTime: new GraphQLScalarType({
          name: "DateTime",
          description: "An ISO-8601 timestamp.",
          specifiedByURL: "https://example.com/date-time",
          serialize: (value) => value,
        }),
      },
    });

    const scalar = schema.getType("DateTime") as GraphQLScalarType;
    expect(scalar.description).toBe("An ISO-8601 timestamp.");
    expect(scalar.specifiedByURL).toBe("https://example.com/date-time");
  });

  it("does not confuse enum values with Object.prototype members", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        enum Color {
          RED
          toString
          constructor
        }

        type Query {
          color: Color
        }
      `,
      resolvers: {
        Color: { RED: "#f00" },
        Query: { color: () => "toString" },
      },
    });

    const result = await graphql({ schema, source: "{ color }" });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ color: "toString" });
  });

  it("binds field resolvers to their per-type resolver object", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: "type Query { helper: String, viaThis: String }",
      resolvers: {
        Query: {
          helper: () => "helped",
          viaThis(this: { helper: () => string }) {
            return this.helper();
          },
        },
      },
    });

    const result = await graphql({ schema, source: "{ viaThis }" });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ viaThis: "helped" });
  });

  it("supports null as an enum internal value, including in defaults", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        enum Color {
          RED
          GREEN
        }

        type Query {
          q(c: Color = RED): String
        }
      `,
      resolvers: {
        Color: { RED: null, GREEN: "g" },
        Query: {
          q: (_root: unknown, args: { c: unknown }) => JSON.stringify(args.c),
        },
      },
    });

    const result = await graphql({ schema, source: "{ a: q, b: q(c: RED) }" });
    expect(result.errors).toBeUndefined();
    // The omitted-arg default and the explicit literal must agree.
    expect(result.data).toEqual({ a: "null", b: "null" });
  });

  it("re-coerces nested input-object defaults regardless of definition order", async () => {
    // Query first, Filter second: the arg default `f: Filter = {}` must still
    // see Filter's re-coerced field default.
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          q(f: Filter = {}): String
        }

        input Filter {
          c: S = "x"
        }

        scalar S
      `,
      resolvers: {
        S: { parseValue: (value: unknown) => `P${String(value)}` },
        Query: {
          q: (_root: unknown, args: { f: unknown }) => JSON.stringify(args.f),
        },
      },
    });

    const result = await graphql({ schema, source: "{ q }" });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ q: '{"c":"Px"}' });
  });

  it("keeps an explicitly attached parseLiteral across later resolver maps", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        scalar S

        type Query {
          echo(value: S): String
        }
      `,
      resolvers: [
        {
          S: {
            parseValue: (value: unknown) => `value:${String(value)}`,
            parseLiteral: (node: unknown) =>
              `literal:${(node as StringValueNode).value}`,
          },
        },
        {
          S: { parseValue: (value: unknown) => `value2:${String(value)}` },
          Query: {
            echo: (_root: unknown, args: { value: string }) => args.value,
          },
        },
      ],
    });

    const result = await graphql({ schema, source: '{ echo(value: "x") }' });
    expect(result.errors).toBeUndefined();
    // The explicit parseLiteral from the first map must not be replaced by a
    // parseLiteral derived from the second map's parseValue.
    expect(result.data).toEqual({ echo: "literal:x" });
  });

  it("merges duplicate schema definitions and identical schema extensions", () => {
    const schema = buildSubgraphSchema({
      typeDefs: [
        "schema { query: MyQuery } type MyQuery { a: String }",
        "schema { query: MyQuery } type MyMutation { b: String }",
        "extend schema { mutation: MyMutation }",
        "extend schema { mutation: MyMutation }",
      ],
    });

    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getQueryType()?.name).toBe("MyQuery");
    expect(schema.getMutationType()?.name).toBe("MyMutation");
  });

  it("merges duplicates that differ only in descriptions, keeping the docs", () => {
    const schema = buildSubgraphSchema({
      typeDefs: [
        "type Query { a: String }",
        '"Docs." type Query { "Field docs." a: String }',
        "directive @tag on FIELD_DEFINITION",
        '"Tag docs." directive @tag on FIELD_DEFINITION',
      ],
    });

    expect(validateSchema(schema)).toEqual([]);
    const query = schema.getQueryType()!;
    expect(query.description).toBe("Docs.");
    expect(query.getFields().a?.description).toBe("Field docs.");
    expect(schema.getDirective("tag")?.description).toBe("Tag docs.");
  });

  it("merges duplicate same-named definitions across documents", () => {
    const schema = buildSubgraphSchema({
      typeDefs: [
        "type Query { a: String }",
        "type Query { a: String, b: String }",
        federationTypeDefsSDL,
        federationTypeDefsSDL,
      ],
    });

    expect(validateSchema(schema)).toEqual([]);
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(["a", "b"]);
  });

  it("still rejects genuinely conflicting duplicate definitions", () => {
    expect(() =>
      buildSubgraphSchema({
        typeDefs: ["type Query { a: String }", "type Query { a: Int }"],
      }),
    ).toThrow(/can only be defined once/);
  });

  it("merges duplicated extend type blocks from shared modules", () => {
    const sharedModule = /* GraphQL */ `
      extend type Product @key(fields: "id") {
        name: String
      }
    `;
    const schema = buildSubgraphSchema({
      typeDefs: [
        "type Query { product: Product @lookup }",
        "type Product { id: ID! }",
        sharedModule,
        sharedModule,
      ],
    });

    expect(validateSchema(schema)).toEqual([]);
    expect(printSubgraphSchema(schema)).toMatchInlineSnapshot(`
      "type Query {
        product: Product @lookup
      }

      type Product @key(fields: "id") {
        id: ID!
        name: String
      }
      "
    `);
  });

  it("converts duplicated baseless extensions exactly once", () => {
    const sharedModule = /* GraphQL */ `
      extend type Product @key(fields: "id") {
        id: ID!
      }
    `;
    const schema = buildSubgraphSchema({
      typeDefs: [
        "type Query { product: Product @lookup }",
        sharedModule,
        sharedModule,
      ],
    });

    expect(validateSchema(schema)).toEqual([]);
    expect(printSubgraphSchema(schema)).toMatchInlineSnapshot(`
      "type Query {
        product: Product @lookup
      }

      type Product @key(fields: "id") {
        id: ID!
      }
      "
    `);
  });

  it("merges duplicates that differ only in nested descriptions", () => {
    const schema = buildSubgraphSchema({
      typeDefs: [
        "type Query { productById(id: ID!): String }",
        'type Query { productById("The id." id: ID!): String }',
        "directive @tag(name: String) on FIELD_DEFINITION",
        'directive @tag("Tag name." name: String) on FIELD_DEFINITION',
      ],
    });

    expect(validateSchema(schema)).toEqual([]);
    expect(printSubgraphSchema(schema)).toMatchInlineSnapshot(`
      "directive @tag(
        "Tag name."
        name: String
      ) on FIELD_DEFINITION

      type Query {
        productById(
          "The id."
          id: ID!
        ): String
      }
      "
    `);
  });

  it("preserves abstract-type resolvers, subscriptions, and defaults through enum value mapping", async () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        directive @paint(color: Color = GREEN) on FIELD_DEFINITION

        enum Color {
          RED
          GREEN
        }

        input Filter {
          colors: [Color!] = [GREEN]
          main: Color = RED
        }

        interface Node {
          id: ID!
        }

        type Thing implements Node {
          id: ID!
          color: Color @paint
        }

        union Anything = Thing

        type Query {
          node(filter: Filter): Node
          anything: Anything
        }

        type Subscription {
          colors: Color
        }
      `,
      resolvers: {
        Color: { RED: "#f00", GREEN: "#0f0" },
        Node: { __resolveType: () => "Thing" },
        Thing: { __isTypeOf: (source: { id?: string }) => "id" in source },
        Query: {
          node: (_root: unknown, args: { filter: unknown }) => ({
            id: "1",
            color: "#f00",
            filter: args.filter,
          }),
          anything: () => ({ id: "2", color: "#0f0" }),
        },
        Subscription: {
          colors: {
            // eslint-disable-next-line @typescript-eslint/require-await
            subscribe: async function* () {
              yield { colors: "#0f0" };
            },
          },
        },
      },
    });

    // Default values inside input objects, lists, and directive definitions
    // are re-coerced to the mapped internal values.
    const filter = schema.getType("Filter") as GraphQLInputObjectType;
    expect(filter.getFields().colors?.defaultValue).toEqual(["#0f0"]);
    expect(filter.getFields().main?.defaultValue).toBe("#f00");
    expect(schema.getDirective("paint")?.args[0]?.defaultValue).toBe("#0f0");

    // __resolveType / __isTypeOf survive the rebuild.
    const result = await graphql({
      schema,
      source: /* GraphQL */ `
        {
          node {
            ... on Thing {
              color
            }
          }
          anything {
            ... on Thing {
              id
            }
          }
        }
      `,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      node: { color: "RED" },
      anything: { id: "2" },
    });

    // subscribe survives the rebuild.
    const iterator = (await subscribe({
      schema,
      document: parse("subscription { colors }"),
    })) as AsyncIterableIterator<{ data?: unknown }>;
    const first = await iterator.next();
    expect((first.value as { data?: unknown }).data).toEqual({
      colors: "GREEN",
    });

    // The healed schema still prints its applied directives and definitions.
    const output = printSubgraphSchema(schema, {
      includeFederationDefinitions: true,
    });
    expect(output).toContain(
      "directive @paint(color: Color = GREEN) on FIELD_DEFINITION",
    );
    expect(output).toContain("color: Color @paint");
  });
});
