import { describe, expect, it } from "vitest";
import {
  buildSchema,
  DirectiveLocation,
  extendSchema,
  GraphQLDirective,
  GraphQLEnumType,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  parse,
  specifiedDirectives,
  validateSchema,
} from "graphql";
import {
  buildSubgraphSchema,
  federationDirectives,
  printSourceSchema,
} from "./index.js";

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

describe("printSourceSchema", () => {
  it("prints applied federation directives", () => {
    const output = printSourceSchema(buildSubgraphSchema({ typeDefs: sdl }));

    expect(output).toContain('@key(fields: "id")');
    expect(output).toContain('@key(fields: "sku")');
    expect(output).toContain("@lookup");
    expect(output).toContain("@internal");
    expect(output).toContain('@is(field: "sku")');
    expect(output).toContain("@shareable");
    expect(output).toContain("@inaccessible");
  });

  it("omits the federation definitions by default", () => {
    const output = printSourceSchema(buildSubgraphSchema({ typeDefs: sdl }));

    expect(output).not.toContain("directive @");
    expect(output).not.toContain("scalar FieldSelectionMap");
    expect(output).not.toContain("scalar FieldSelectionSet");
  });

  it("round-trips through buildSubgraphSchema", () => {
    const output = printSourceSchema(buildSubgraphSchema({ typeDefs: sdl }));
    const rebuilt = buildSubgraphSchema({ typeDefs: output });

    expect(validateSchema(rebuilt)).toEqual([]);
    expect(printSourceSchema(rebuilt)).toEqual(output);
  });

  it("produces self-contained SDL with includeFederationDefinitions", () => {
    const output = printSourceSchema(buildSubgraphSchema({ typeDefs: sdl }), {
      includeFederationDefinitions: true,
    });

    expect(output).toContain(
      "directive @key(fields: FieldSelectionSet!) repeatable on OBJECT | INTERFACE",
    );
    expect(output).toContain("scalar FieldSelectionMap");

    const standalone = buildSchema(output);
    expect(validateSchema(standalone)).toEqual([]);
  });

  it("omits the schema block for default root type names, keeps custom ones", () => {
    const output = printSourceSchema(buildSubgraphSchema({ typeDefs: sdl }));
    expect(output).not.toContain("schema {");

    const custom = printSourceSchema(
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
    expect(custom).toContain("schema {");
    expect(custom).toContain("query: QueryRoot");
  });

  it("keeps user-customized federation-named definitions and round-trips them", () => {
    const output = printSourceSchema(
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
      "directive @key(fields: FieldSelectionSet!, futureArg: String) repeatable on OBJECT | INTERFACE",
    );
    expect(output).toContain('@key(fields: "id", futureArg: "x")');
    // The user's FieldSelectionSet copy matches the spec, so it is still omitted.
    expect(output).not.toContain("scalar FieldSelectionSet");

    const rebuilt = buildSubgraphSchema({ typeDefs: output });
    expect(validateSchema(rebuilt)).toEqual([]);
    expect(rebuilt.getDirective("key")?.args.map((arg) => arg.name)).toEqual([
      "fields",
      "futureArg",
    ]);
    expect(printSourceSchema(rebuilt)).toEqual(output);
  });

  it("still omits user-supplied exact copies of spec definitions", () => {
    const output = printSourceSchema(
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

    expect(output).not.toContain("directive @lookup");
    expect(output).toContain("@lookup");
  });

  it("keeps non-federation custom directives and their definitions", () => {
    const output = printSourceSchema(
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

    expect(output).toContain("directive @mine on FIELD_DEFINITION");
    expect(output).toContain("@mine");
    expect(output).not.toContain("directive @lookup");
  });

  it("merges type extensions into a single printed definition", () => {
    const output = printSourceSchema(
      buildSubgraphSchema({
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
      }),
    );

    expect(output).not.toContain("extend type");
    expect(output).toContain('type Product @key(fields: "id") {');
    expect(output).toContain("name: String");

    const rebuilt = buildSubgraphSchema({ typeDefs: output });
    expect(validateSchema(rebuilt)).toEqual([]);
    expect(printSourceSchema(rebuilt)).toEqual(output);
  });

  it("merges extendSchema-built extensions into a single printed definition", () => {
    const schema = extendSchema(
      buildSchema("type Query { a: String }"),
      parse("extend type Query { b: String }"),
    );

    const output = printSourceSchema(schema);
    expect(output).not.toContain("extend type");
    expect(output).toContain("a: String");
    expect(output).toContain("b: String");
  });

  it("prints code-first schemas via the extensions.directives convention", () => {
    const product: GraphQLObjectType = new GraphQLObjectType({
      name: "Product",
      // Record form; an array of argument maps repeats the directive.
      extensions: {
        directives: { key: [{ fields: "id" }, { fields: "sku" }] },
      },
      fields: {
        id: { type: new GraphQLNonNull(GraphQLID) },
        sku: { type: GraphQLString },
        name: {
          type: GraphQLString,
          extensions: { directives: { shareable: {} } },
        },
      },
    });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          productById: {
            type: product,
            args: { id: { type: new GraphQLNonNull(GraphQLID) } },
            // List form.
            extensions: { directives: [{ name: "lookup" }] },
          },
        },
      }),
      directives: [...specifiedDirectives, ...federationDirectives],
    });

    const output = printSourceSchema(schema);
    expect(output).toContain(
      'type Product @key(fields: "id") @key(fields: "sku") {',
    );
    expect(output).toContain("name: String @shareable");
    expect(output).toContain("productById(id: ID!): Product @lookup");
    // The spec definitions are still recognized and omitted.
    expect(output).not.toContain("directive @");
    expect(output).not.toContain("scalar FieldSelectionSet");
    expect(output).not.toContain("schema {");
  });

  it("synthesizes deprecations and specifiedBy for code-first schemas", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          old: { type: GraphQLString, deprecationReason: "Use somethingElse." },
          gone: {
            type: GraphQLString,
            deprecationReason: "No longer supported",
          },
          spec: {
            type: new GraphQLScalarType({
              name: "MyScalar",
              specifiedByURL: "https://example.com/my-scalar",
            }),
          },
        },
      }),
    });

    const output = printSourceSchema(schema);
    expect(output).toContain(
      'old: String @deprecated(reason: "Use somethingElse.")',
    );
    expect(output).toContain("gone: String @deprecated\n");
    expect(output).toContain(
      'scalar MyScalar @specifiedBy(url: "https://example.com/my-scalar")',
    );
  });

  it("prints the schema block for code-first schemas with custom root names", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "RootQuery",
        fields: { ok: { type: GraphQLString } },
      }),
    });

    const output = printSourceSchema(schema);
    expect(output).toContain("schema {");
    expect(output).toContain("query: RootQuery");
  });

  it("prints @oneOf for code-first oneOf input objects", () => {
    const searchBy = new GraphQLInputObjectType({
      name: "SearchBy",
      isOneOf: true,
      fields: {
        id: { type: GraphQLID },
        email: { type: GraphQLString },
      },
    });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          find: { type: GraphQLString, args: { by: { type: searchBy } } },
        },
      }),
    });

    const output = printSourceSchema(schema);
    expect(output).toContain("input SearchBy @oneOf {");
  });

  it("keeps directives applied via extendSchema on a code-first schema", () => {
    const codeFirst = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: { product: { type: GraphQLString } },
      }),
      directives: [...specifiedDirectives, ...federationDirectives],
    });
    const extended = extendSchema(
      codeFirst,
      parse(
        'extend type Query @key(fields: "product") { sku: String @external }',
      ),
    );

    const output = printSourceSchema(extended);
    expect(output).toContain('type Query @key(fields: "product") {');
    expect(output).toContain("sku: String @external");
  });

  it("does not duplicate @deprecated or @specifiedBy already present in extensions.directives", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          f: {
            type: GraphQLString,
            deprecationReason: "use g",
            extensions: { directives: { deprecated: { reason: "use g" } } },
          },
          url: {
            type: new GraphQLScalarType({
              name: "URL",
              specifiedByURL: "https://url.spec.whatwg.org/",
              extensions: {
                directives: {
                  specifiedBy: { url: "https://url.spec.whatwg.org/" },
                },
              },
            }),
          },
        },
      }),
    });

    const output = printSourceSchema(schema);
    expect(output.match(/@deprecated/g)).toHaveLength(1);
    expect(output.match(/@specifiedBy/g)).toHaveLength(1);
  });

  it("merges extensions.directives into SDL-built elements", () => {
    const schema = buildSchema(/* GraphQL */ `
      directive @tag(name: String!) repeatable on OBJECT | FIELD_DEFINITION

      type Query {
        hello: String @tag(name: "from-sdl")
      }
    `);
    const query = schema.getQueryType()!;
    query.extensions = {
      ...query.extensions,
      directives: { tag: { name: "type-extension" } },
    };
    const hello = query.getFields().hello!;
    hello.extensions = {
      ...hello.extensions,
      directives: {
        tag: [{ name: "from-sdl" }, { name: "field-extension" }],
      },
    };

    const output = printSourceSchema(schema);
    expect(output).toContain('type Query @tag(name: "type-extension") {');
    // The duplicate of the AST-applied directive is dropped; the new one kept.
    expect(output).toContain(
      'hello: String @tag(name: "from-sdl") @tag(name: "field-extension")',
    );
  });

  it("merges extensions.directives on arguments of SDL-built fields", () => {
    const schema = buildSchema(/* GraphQL */ `
      directive @constraint(max: Int) on ARGUMENT_DEFINITION

      type Query {
        a(limit: Int): String
      }
    `);
    const arg = schema.getQueryType()!.getFields().a!.args[0]!;
    arg.extensions = {
      ...arg.extensions,
      directives: { constraint: { max: 10 } },
    };

    const output = printSourceSchema(schema);
    expect(output).toContain("a(limit: Int @constraint(max: 10)): String");
  });

  it("does not repeat a non-repeatable directive over spelling differences", () => {
    const schema = buildSchema(/* GraphQL */ `
      directive @weight(value: Float) on OBJECT

      type Query @weight(value: 1.0) {
        a: String
      }
    `);
    const query = schema.getQueryType()!;
    // The coerced-value form graphql-tools pipelines store: prints as
    // `value: 1`, not `value: 1.0` — it must still count as the same
    // application.
    query.extensions = {
      ...query.extensions,
      directives: { weight: { value: 1 } },
    };

    const output = printSourceSchema(schema);
    expect(output).toContain("type Query @weight(value: 1.0) {");
    expect(() => buildSchema(output)).not.toThrow();
  });

  it("keeps identical repetitions of a repeatable directive from extensions", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        extensions: {
          directives: { tag: [{ name: "x" }, { name: "x" }] },
        },
        fields: { a: { type: GraphQLString } },
      }),
      directives: [
        ...specifiedDirectives,
        new GraphQLDirective({
          name: "tag",
          isRepeatable: true,
          locations: [DirectiveLocation.OBJECT],
          args: { name: { type: GraphQLString } },
        }),
      ],
    });

    const output = printSourceSchema(schema);
    expect(output).toContain('type Query @tag(name: "x") @tag(name: "x") {');
  });

  it("prints enum-typed extension directive args as enum literals", () => {
    const level = new GraphQLEnumType({
      name: "Level",
      values: { HIGH: { value: 10 }, LOW: { value: 0 } },
    });
    const marked = new GraphQLDirective({
      name: "marked",
      locations: [DirectiveLocation.FIELD_DEFINITION],
      args: { level: { type: level } },
    });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          f: {
            type: GraphQLString,
            extensions: { directives: { marked: { level: "HIGH" } } },
          },
        },
      }),
      directives: [...specifiedDirectives, marked],
    });

    const output = printSourceSchema(schema);
    expect(output).toContain("f: String @marked(level: HIGH)");
  });

  it("merges enum, union, input, scalar, and schema extensions when printing", () => {
    const output = printSourceSchema(
      buildSubgraphSchema({
        typeDefs: /* GraphQL */ `
          directive @stamp on SCHEMA | ENUM | UNION | INPUT_OBJECT | SCALAR

          scalar Money

          enum Color {
            RED
          }

          union Item = Product

          input Filter {
            a: String
          }

          type Query {
            item: Item
            money: Money
            filtered(filter: Filter): Product
            color: Color
          }

          type Product {
            id: ID!
          }

          type Extra {
            id: ID!
          }

          extend schema @stamp
          extend enum Color {
            GREEN
          }
          extend union Item = Extra
          extend input Filter {
            b: String
          }
          extend scalar Money @stamp
        `,
      }),
    );

    expect(output).not.toContain("extend ");
    expect(output).toContain("schema @stamp {");
    expect(output).toContain("enum Color {\n  RED\n  GREEN\n}");
    expect(output).toContain("union Item = Product | Extra");
    expect(output).toContain("a: String");
    expect(output).toContain("b: String");
    expect(output).toContain("scalar Money @stamp");

    const rebuilt = buildSubgraphSchema({ typeDefs: output });
    expect(validateSchema(rebuilt)).toEqual([]);
    expect(printSourceSchema(rebuilt)).toEqual(output);
  });
});
