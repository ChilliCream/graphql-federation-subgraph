import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import mercurius from "mercurius";
import { buildSubgraphSchema, createSourceSchemaHandler } from "../index.js";
import {
  expectedData,
  fetchIntrospectionSdl,
  fetchSourceSchemaSdl,
  postGraphQL,
  resolvers,
  typeDefs,
} from "./fixture.js";

describe("mercurius", () => {
  let app: FastifyInstance;
  let url: string;
  let schemaUrl: string;

  beforeAll(async () => {
    const schema = buildSubgraphSchema({ typeDefs, resolvers });
    const schemaHandler = createSourceSchemaHandler(schema);

    app = Fastify();
    app.register(mercurius, { schema });
    // hijack() hands the raw request/response pair to the handler, keeping
    // Fastify from sending its own response on top.
    app.get("/graphql/schema.graphql", (request, reply) => {
      reply.hijack();
      schemaHandler(request.raw, reply.raw);
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/graphql`;
    schemaUrl = `${url}/schema.graphql`;
  });

  afterAll(() => app.close());

  it("serves the subgraph schema over HTTP", async () => {
    const result = await postGraphQL(url);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual(expectedData);
  });

  it("serves the federation definitions via introspection", async () => {
    await expect(await fetchIntrospectionSdl(url)).toMatchFileSnapshot(
      "./__snapshots__/introspection.graphql",
    );
  });

  it("serves the source schema document with applied directives", async () => {
    await expect(await fetchSourceSchemaSdl(schemaUrl)).toMatchFileSnapshot(
      "./__snapshots__/schema.graphql",
    );
  });
});
