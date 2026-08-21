import {
  buildASTSchema,
  buildSchema,
  DirectiveLocation,
  extendSchema,
  GraphQLDirective,
  GraphQLInt,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  parse,
  print,
  printSchema,
  validateSchema,
} from "graphql";
import { describe, expect, it } from "vitest";
import { getDocumentFromSchema } from "./get-document-from-schema.js";
import { buildSubgraphSchema } from "./index.js";

describe("getDocumentFromSchema", () => {
  const schema = buildSubgraphSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        productById(id: ID!): Product @lookup
      }

      type Product @key(fields: "id") {
        id: ID!
      }
    `,
  });

  it("keeps every definition, including the ones printSubgraphSchema omits", async () => {
    await expect(print(getDocumentFromSchema(schema))).toMatchFileSnapshot(
      "./__snapshots__/get-document-from-schema.graphql",
    );
  });

  it("produces a document buildASTSchema accepts, preserving the schema", async () => {
    const rebuilt = buildASTSchema(getDocumentFromSchema(schema));
    expect(printSchema(rebuilt)).toBe(printSchema(schema));
    await expect(printSchema(rebuilt)).toMatchFileSnapshot(
      "./__snapshots__/get-document-from-schema.round-trip.graphql",
    );
  });

  it("emits a schema definition for mutation-only code-first schemas", () => {
    const document = getDocumentFromSchema(
      new GraphQLSchema({
        mutation: new GraphQLObjectType({
          name: "RootMutation",
          fields: { ping: { type: GraphQLString } },
        }),
      }),
    );

    expect(print(document)).toMatchInlineSnapshot(`
      "schema {
        mutation: RootMutation
      }

      type RootMutation {
        ping: String
      }"
    `);
  });

  it("synthesizes directive definitions from code-first GraphQLDirective instances", () => {
    const document = getDocumentFromSchema(
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: { a: { type: GraphQLString } },
        }),
        directives: [
          new GraphQLDirective({
            name: "limit",
            isRepeatable: true,
            locations: [DirectiveLocation.FIELD_DEFINITION],
            args: { max: { type: GraphQLInt, defaultValue: 10 } },
          }),
        ],
      }),
    );

    expect(print(document)).toMatchInlineSnapshot(`
      "directive @limit(max: Int = 10) repeatable on FIELD_DEFINITION

      type Query {
        a: String
      }"
    `);
  });

  it("renders extension directive args of unknown directives as untyped literals", () => {
    const document = getDocumentFromSchema(
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            a: {
              type: GraphQLString,
              extensions: {
                directives: {
                  meta: {
                    tags: ["a", "b"],
                    weight: 1.5,
                    flag: true,
                    note: null,
                    nested: { count: 1 },
                  },
                },
              },
            },
          },
        }),
      }),
    );

    // The expected SDL is round-tripped through the installed printer so the
    // comparison is exact on both graphql@16 and graphql@17, whose printers
    // format object values differently ({count: 1} vs { count: 1 }).
    expect(print(document)).toBe(
      print(
        parse(/* GraphQL */ `
          type Query {
            a: String
              @meta(
                tags: ["a", "b"]
                weight: 1.5
                flag: true
                note: null
                nested: { count: 1 }
              )
          }
        `),
      ),
    );
  });

  it("prints every application of a repeatable directive from extensions", () => {
    // No federationDirectives registered on the schema, so @key is unknown
    // to it — repetitions must survive printing regardless.
    const product = new GraphQLObjectType({
      name: "Product",
      extensions: {
        directives: { key: [{ fields: "id" }, { fields: "sku" }] },
      },
      fields: { id: { type: GraphQLString } },
    });
    const document = getDocumentFromSchema(
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: { product: { type: product } },
        }),
      }),
    );

    expect(print(document)).toMatchInlineSnapshot(`
      "type Query {
        product: Product
      }

      type Product @key(fields: "id") @key(fields: "sku") {
        id: String
      }"
    `);
  });

  it("prefers live root types over stale schema AST entries", () => {
    const sdlSchema = buildSchema(
      "schema { query: OldQ } type OldQ { a: String } type NewQ { b: String }",
    );
    // Replace the query root programmatically; the astNode still names OldQ.
    const schema = new GraphQLSchema({
      ...sdlSchema.toConfig(),
      query: sdlSchema.getType("NewQ") as GraphQLObjectType,
    });

    expect(print(getDocumentFromSchema(schema))).toMatchInlineSnapshot(`
      "schema {
        query: NewQ
      }

      type OldQ {
        a: String
      }

      type NewQ {
        b: String
      }"
    `);
  });

  it("dedupes unknown extension directives by argument value, not spelling", () => {
    // @provides is applied in SDL as a block string and mirrored into
    // extensions.directives as a plain string (the graphql-tools convention);
    // the same value must not print twice. @external is listed twice
    // identically; exact duplicates of an unknown directive collapse.
    const schema = buildASTSchema(
      parse(/* GraphQL */ `
        type Query {
          product: Product
        }

        type Product {
          id: ID
          name: String
          price: Int @provides(fields: """id name""")
        }
      `),
      { assumeValidSDL: true },
    );
    const fields = (schema.getType("Product") as GraphQLObjectType).getFields();

    Object.assign(fields.price!, {
      extensions: { directives: { provides: { fields: "id name" } } },
    });
    Object.assign(fields.name!, {
      extensions: { directives: [{ name: "external" }, { name: "external" }] },
    });

    expect(print(getDocumentFromSchema(schema))).toMatchInlineSnapshot(`
      "type Query {
        product: Product
      }

      type Product {
        id: ID
        name: String @external
        price: Int @provides(fields: """id name""")
      }"
    `);
  });

  it("keeps live root types the schema AST does not mention", () => {
    const schema = extendSchema(
      buildSchema("type Query { a: String }"),
      parse("extend schema { mutation: M } type M { x: String }"),
    );
    const printed = print(getDocumentFromSchema(schema));

    expect(printed).toMatchInlineSnapshot(`
      "schema {
        query: Query
        mutation: M
      }

      type Query {
        a: String
      }

      type M {
        x: String
      }"
    `);
    expect(validateSchema(buildASTSchema(parse(printed)))).toEqual([]);
  });

  it("prints schema directives without root types as a schema extension", () => {
    const schema = buildSchema(
      "directive @stamp on SCHEMA type Dummy { a: String } extend schema @stamp",
      { assumeValidSDL: true },
    );
    const printed = print(getDocumentFromSchema(schema));

    expect(printed).toMatchInlineSnapshot(`
      "extend schema @stamp

      directive @stamp on SCHEMA

      type Dummy {
        a: String
      }"
    `);
    expect(() => parse(printed)).not.toThrow();
  });

  it("keeps a programmatic schema description alongside extension nodes", () => {
    const base = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: { a: { type: GraphQLString } },
      }),
    });
    // extendSchema drops config descriptions (it only reads them from a
    // schema-definition node), so the description is restored onto the
    // extended schema to get a schema with extension AST nodes but no
    // astNode AND a live description.
    const schema = new GraphQLSchema({
      ...extendSchema(
        base,
        parse("directive @stamp on SCHEMA extend schema @stamp"),
      ).toConfig(),
      description: "My subgraph.",
    });

    expect(print(getDocumentFromSchema(schema))).toMatchInlineSnapshot(`
      """"My subgraph."""
      schema @stamp {
        query: Query
      }

      directive @stamp on SCHEMA

      type Query {
        a: String
      }"
    `);
  });

  it("prints graphql 17 style default usages on code-first arguments", () => {
    const query = new GraphQLObjectType({
      name: "Query",
      fields: {
        echo: {
          type: GraphQLString,
          args: {
            max: { type: GraphQLInt },
            min: { type: GraphQLInt },
            step: { type: GraphQLInt },
          },
        },
      },
    });
    const schema = new GraphQLSchema({ query });
    const [max, min, step] = query.getFields().echo!.args;

    // graphql 17 stores code-first defaults as a `default` usage instead of
    // `defaultValue`; simulate both of its shapes on graphql 16 objects.
    // When both fields are present, `default` wins — the precedence of
    // graphql 17's own getDefaultValueAST.
    Object.assign(max!, { default: { value: 10 } });
    Object.assign(min!, {
      default: { literal: { kind: Kind.INT, value: "7" } },
    });
    Object.assign(step!, { defaultValue: 1, default: { value: 2 } });

    expect(print(getDocumentFromSchema(schema))).toMatchInlineSnapshot(`
      "type Query {
        echo(max: Int = 10, min: Int = 7, step: Int = 2): String
      }"
    `);
  });
});
