import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import mercurius from "mercurius";
import { buildSubgraphSchema } from "../index.js";
import { expectedData, postGraphQL, resolvers, typeDefs } from "./fixture.js";

describe("mercurius", () => {
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(mercurius, {
      schema: buildSubgraphSchema({ typeDefs, resolvers })
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/graphql`;
  });

  afterAll(() => app.close());

  it("serves the subgraph schema over HTTP", async () => {
    const result = await postGraphQL(url);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual(expectedData);
  });
});
