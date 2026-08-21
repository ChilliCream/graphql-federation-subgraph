import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "graphql-http/lib/use/http";
import { buildSubgraphSchema, createSourceSchemaHandler } from "../index.js";
import {
  expectedData,
  fetchIntrospectionSdl,
  fetchSourceSchemaSdl,
  postGraphQL,
  resolvers,
  typeDefs,
} from "./fixture.js";

describe("graphql-http", () => {
  let server: Server;
  let url: string;
  let schemaUrl: string;

  beforeAll(async () => {
    const schema = buildSubgraphSchema({ typeDefs, resolvers });
    const handler = createHandler({ schema });
    const schemaHandler = createSourceSchemaHandler(schema);

    server = createServer((req, res) => {
      if (req.url?.split("?")[0] === "/graphql/schema.graphql") {
        schemaHandler(req, res);

        return;
      }

      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/graphql`;
    schemaUrl = `${url}/schema.graphql`;
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
