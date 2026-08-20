import {
  buildASTSchema,
  graphql,
  GraphQLEnumType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  parse,
} from "graphql";
import { describe, expect, it } from "vitest";
import { attachResolvers } from "./attach-resolvers.js";

describe("attachResolvers", () => {
  it("returns the same schema instance unless enum values are mapped", () => {
    const schema = buildASTSchema(parse("type Query { a: String }"));

    expect(attachResolvers(schema, [])).toBe(schema);
    expect(attachResolvers(schema, [{ Query: { a: () => "a" } }])).toBe(schema);
  });

  it("rebuilds without mutating the original schema when enum values are mapped", () => {
    const schema = buildASTSchema(
      parse("enum Color { RED } type Query { c: Color }"),
    );

    const result = attachResolvers(schema, [{ Color: { RED: "#f00" } }]);

    expect(result).not.toBe(schema);
    const original = schema.getType("Color") as GraphQLEnumType;
    const rebuilt = result.getType("Color") as GraphQLEnumType;
    expect(original.getValues()[0]?.value).toBe("RED");
    expect(rebuilt.getValues()[0]?.value).toBe("#f00");
  });

  it("attaches resolvers to code-first schemas and keeps programmatic defaults", async () => {
    const upper = new GraphQLScalarType({ name: "Upper" });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          echo: {
            type: GraphQLString,
            args: { value: { type: upper, defaultValue: "x" } },
            resolve: (_root, args: { value: string }) => args.value,
          },
        },
      }),
    });

    const result = attachResolvers(schema, [
      {
        Upper: { parseValue: (value: unknown) => String(value).toUpperCase() },
      },
    ]);

    // Code-first arguments have no SDL AST, so the default-value re-coercion
    // pass must leave their programmatic defaults untouched.
    const arg = (result.getType("Query") as GraphQLObjectType)
      .getFields()
      .echo?.args.find((candidate) => candidate.name === "value");
    expect(arg?.defaultValue).toBe("x");

    const executed = await graphql({
      schema: result,
      source: "query ($value: Upper) { echo(value: $value) }",
      variableValues: { value: "abc" },
    });
    expect(executed.errors).toBeUndefined();
    expect(executed.data).toEqual({ echo: "ABC" });
  });

  it("mirrors scalar functions onto graphql-17 coercion methods when present", () => {
    const schema = buildASTSchema(parse("scalar S type Query { a: S }"));
    const scalar = schema.getType("S") as GraphQLScalarType;
    // graphql@16 has no coerce* methods; simulate a graphql-17 scalar by
    // pre-defining them, the shape setScalarFunction detects.
    const target = scalar as unknown as Record<string, unknown>;
    target.coerceOutputValue = () => undefined;
    target.coerceInputValue = () => undefined;
    target.coerceInputLiteral = () => undefined;

    const serialize = (value: unknown): unknown => value;
    const parseValue = (value: unknown): unknown => value;
    attachResolvers(schema, [{ S: { serialize, parseValue } }]);

    expect(target.coerceOutputValue).toBe(serialize);
    expect(target.coerceInputValue).toBe(parseValue);
    // parseLiteral is derived from parseValue, so the mirror is the derived
    // function — not the stale placeholder.
    expect(target.coerceInputLiteral).toBe(scalar.parseLiteral);
  });
});
