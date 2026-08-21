import { describe, expect, it } from "vitest";
import {
  buildSubgraphSchema,
  createSourceSchemaHandler,
  printSourceSchema,
} from "./index.js";

const sdl = /* GraphQL */ `
  type Query {
    productById(id: ID!): Product @lookup
  }

  type Product @key(fields: "id") {
    id: ID!
    name: String!
  }
`;

/* eslint-disable no-restricted-syntax -- a recorder is mutable by contract:
   the handler under test writes `statusCode`, and `end` records into `body`
   and `ended` */
interface RecordedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string | undefined;
  ended: boolean;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}
/* eslint-enable no-restricted-syntax */

function createResponse(): RecordedResponse {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    end(body?: string): void {
      this.body = body;
      this.ended = true;
    },
  };
}

describe("createSourceSchemaHandler", () => {
  it("serves the source schema document on GET", () => {
    const schema = buildSubgraphSchema({ typeDefs: sdl });
    const handler = createSourceSchemaHandler(schema);
    const response = createResponse();

    handler({ method: "GET" }, response);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/graphql; charset=utf-8",
    );
    expect(response.ended).toBe(true);
    expect(response.body).toBe(printSourceSchema(schema));
    expect(response.body).toContain('@key(fields: "id")');
    expect(response.body).toContain("@lookup");
  });

  it("treats the request method case-insensitively", () => {
    const handler = createSourceSchemaHandler(
      buildSubgraphSchema({ typeDefs: sdl }),
    );
    const response = createResponse();

    handler({ method: "get" }, response);

    expect(response.statusCode).toBe(200);
  });

  it("answers HEAD with headers only", () => {
    const schema = buildSubgraphSchema({ typeDefs: sdl });
    const handler = createSourceSchemaHandler(schema);
    const head = createResponse();
    const get = createResponse();

    handler({ method: "HEAD" }, head);
    handler({ method: "GET" }, get);

    expect(head.statusCode).toBe(200);
    expect(head.body).toBeUndefined();
    expect(head.ended).toBe(true);
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
  });

  it("rejects other methods with 405 and an Allow header", () => {
    const handler = createSourceSchemaHandler(
      buildSubgraphSchema({ typeDefs: sdl }),
    );

    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", undefined]) {
      const response = createResponse();

      handler({ method }, response);

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("GET, HEAD");
      expect(response.ended).toBe(true);
      expect(response.body).toBeUndefined();
    }
  });

  it("reports the content length in bytes, not characters", () => {
    const schema = buildSubgraphSchema({
      typeDefs: /* GraphQL */ `
        """
        Ünïcödé ★
        """
        type Query {
          product: Product
        }

        type Product @key(fields: "id") {
          id: ID!
        }
      `,
    });
    const handler = createSourceSchemaHandler(schema);
    const response = createResponse();

    handler({ method: "GET" }, response);

    const body = response.body ?? "";

    expect(new TextEncoder().encode(body).length).toBeGreaterThan(body.length);
    expect(response.headers["content-length"]).toBe(
      String(new TextEncoder().encode(body).length),
    );
  });

  it("forwards print options", () => {
    const handler = createSourceSchemaHandler(
      buildSubgraphSchema({ typeDefs: sdl }),
      { includeFederationDefinitions: true },
    );
    const response = createResponse();

    handler({ method: "GET" }, response);

    expect(response.body).toContain("directive @key");
    expect(response.body).toContain("scalar FieldSelectionSet");
  });
});
