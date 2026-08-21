/**
 * Shared schema, resolvers, and HTTP helpers for the server e2e tests. Every
 * server from the README boots with this subgraph schema and must answer the
 * same query — and expose the same SDL through introspection, and the same
 * source schema document at /graphql/schema.graphql — the same way.
 */
import {
  buildClientSchema,
  getIntrospectionQuery,
  lexicographicSortSchema,
  printSchema,
  type IntrospectionQuery,
} from "graphql";

export const typeDefs = /* GraphQL */ `
  type Query {
    productById(id: ID!): Product @lookup
    productBySku(sku: String! @is(field: "sku")): Product @lookup
  }

  type Product @key(fields: "id") @key(fields: "sku") {
    id: ID!
    sku: String!
    name: String! @shareable
  }
`;

const products = [
  { id: "1", sku: "A-1", name: "Chair" },
  { id: "2", sku: "B-2", name: "Table" },
];

export const resolvers = {
  Query: {
    productById: (_parent: unknown, args: { id: string }) =>
      products.find((product) => product.id === args.id),
    productBySku: (_parent: unknown, args: { sku: string }) =>
      products.find((product) => product.sku === args.sku),
  },
};

export const testQuery = /* GraphQL */ `
  {
    productById(id: "1") {
      id
      name
    }
    productBySku(sku: "B-2") {
      name
    }
  }
`;

export const expectedData = {
  productById: { id: "1", name: "Chair" },
  productBySku: { name: "Table" },
};

/**
 * Fetches the schema a server exposes through standard introspection, as SDL.
 * Every server is checked against the single shared snapshot in
 * `__snapshots__/introspection.graphql`; the schema is sorted
 * lexicographically so servers that assemble it themselves from SDL (NestJS
 * schema-first) print the same text regardless of definition order.
 */
export async function fetchIntrospectionSdl(url: string): Promise<string> {
  // directiveIsRepeatable is off by default but @key/@shareable are
  // repeatable; without it the round-tripped SDL would drop `repeatable`.
  const result = await postGraphQL(
    url,
    getIntrospectionQuery({ directiveIsRepeatable: true }),
  );

  if (result.errors !== undefined || result.data === undefined) {
    throw new Error(`Introspection failed: ${JSON.stringify(result.errors)}`);
  }

  return printSchema(
    lexicographicSortSchema(
      buildClientSchema(result.data as unknown as IntrospectionQuery),
    ),
  );
}

/**
 * Fetches the source schema document a server exposes at
 * `/graphql/schema.graphql`. Every server is checked against the shared
 * snapshot in `__snapshots__/schema.graphql` — which, unlike the
 * introspection snapshot, keeps the applied federation directives.
 *
 * The transport details the README promises are pinned along the way, since
 * they rest on host-server plumbing the snapshot alone would not catch (e.g.
 * Fastify's `exposeHeadRoutes` default and Express's implicit HEAD routing):
 * a query string must not change the routing, and HEAD must answer with the
 * document's headers — including its content-length in bytes — and no body.
 */
export async function fetchSourceSchemaSdl(url: string): Promise<string> {
  const sdl = await readSchemaResponse(await fetch(url));

  const withQueryString = await readSchemaResponse(
    await fetch(`${url}?tooling=probe`),
  );

  if (withQueryString !== sdl) {
    throw new Error("A query string changed the served schema document.");
  }

  const head = await fetch(url, { method: "HEAD" });

  if (head.status !== 200) {
    throw new Error(`HEAD failed: HTTP ${head.status}`);
  }

  const contentLength = String(new TextEncoder().encode(sdl).length);

  if (head.headers.get("content-length") !== contentLength) {
    throw new Error(
      `HEAD content-length ${String(head.headers.get("content-length"))} does` +
        ` not match the document's ${contentLength} bytes.`,
    );
  }

  if ((await head.text()) !== "") {
    throw new Error("HEAD answered with a body.");
  }

  return sdl;
}

async function readSchemaResponse(response: Response): Promise<string> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const contentType = response.headers.get("content-type");

  if (contentType !== "application/graphql; charset=utf-8") {
    throw new Error(`Unexpected content-type: ${String(contentType)}`);
  }

  return response.text();
}

export async function postGraphQL(
  url: string,
  query: string = testQuery,
): Promise<{ data?: unknown; errors?: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/graphql-response+json, application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as { data?: unknown; errors?: unknown };
}
