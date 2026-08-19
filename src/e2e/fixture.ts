/**
 * Shared schema, resolvers, and HTTP helpers for the server e2e tests. Every
 * server from the README boots with this subgraph schema and must answer the
 * same query the same way.
 */
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
  { id: '1', sku: 'A-1', name: 'Chair' },
  { id: '2', sku: 'B-2', name: 'Table' },
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
  productById: { id: '1', name: 'Chair' },
  productBySku: { name: 'Table' },
};

export async function postGraphQL(
  url: string,
  query: string = testQuery,
): Promise<{ data?: unknown; errors?: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/graphql-response+json, application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as { data?: unknown; errors?: unknown };
}
