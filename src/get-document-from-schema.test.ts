import {
  buildASTSchema,
  DirectiveLocation,
  GraphQLDirective,
  GraphQLInt,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  print,
  printSchema,
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

    expect(print(document)).toMatchInlineSnapshot(`
      "type Query {
        a: String @meta(tags: ["a", "b"], weight: 1.5, flag: true, note: null, nested: {count: 1})
      }"
    `);
  });
});
