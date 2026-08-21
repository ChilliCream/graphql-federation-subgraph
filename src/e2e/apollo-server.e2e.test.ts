import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { buildSubgraphSchema, createSourceSchemaHandler } from "../index.js";
import {
  expectedData,
  fetchIntrospectionSdl,
  fetchSourceSchemaSdl,
  postGraphQL,
  resolvers,
  typeDefs,
} from "./fixture.js";

// The Express integration instead of startStandaloneServer, which handles
// every path itself and cannot mount the schema document route next to the
// GraphQL endpoint.
describe("@apollo/server", () => {
  let server: ApolloServer;
  let httpServer: Server;
  let url: string;
  let schemaUrl: string;

  beforeAll(async () => {
    const schema = buildSubgraphSchema({ typeDefs, resolvers });
    server = new ApolloServer({ schema });
    await server.start();

    const app = express();
    app.get("/graphql/schema.graphql", createSourceSchemaHandler(schema));
    app.use("/graphql", express.json(), expressMiddleware(server));

    httpServer = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/graphql`;
    schemaUrl = `${url}/schema.graphql`;
  });

  afterAll(async () => {
    await server.stop();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

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
