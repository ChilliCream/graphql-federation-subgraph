import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { buildSubgraphSchema } from "../index.js";
import { expectedData, postGraphQL, resolvers, typeDefs } from "./fixture.js";

describe("@apollo/server", () => {
  let server: ApolloServer;
  let url: string;

  beforeAll(async () => {
    server = new ApolloServer({
      schema: buildSubgraphSchema({ typeDefs, resolvers }),
    });
    ({ url } = await startStandaloneServer(server, { listen: { port: 0 } }));
  });

  afterAll(() => server.stop());

  it("serves the subgraph schema over HTTP", async () => {
    const result = await postGraphQL(url);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual(expectedData);
  });
});
