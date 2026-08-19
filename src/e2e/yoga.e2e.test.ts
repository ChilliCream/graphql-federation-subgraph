import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createYoga } from "graphql-yoga";
import { buildSubgraphSchema } from "../index.js";
import { expectedData, postGraphQL, resolvers, typeDefs } from "./fixture.js";

describe("graphql-yoga", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const yoga = createYoga({
      schema: buildSubgraphSchema({ typeDefs, resolvers }),
    });
    server = createServer((req, res) => void yoga(req, res));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/graphql`;
  });

  afterAll(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  it("serves the subgraph schema over HTTP", async () => {
    const result = await postGraphQL(url);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual(expectedData);
  });
});
