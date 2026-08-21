import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { GraphQLModule, GraphQLSchemaHost } from "@nestjs/graphql";
import { ApolloDriver, type ApolloDriverConfig } from "@nestjs/apollo";
import {
  createSourceSchemaHandler,
  federationTypeDefsSDL,
  type SourceSchemaHandler,
} from "../index.js";
import {
  expectedData,
  fetchIntrospectionSdl,
  fetchSourceSchemaSdl,
  postGraphQL,
  resolvers,
  typeDefs,
} from "./fixture.js";

// Schema-first NestJS: the federation definitions are contributed as plain
// typeDefs next to the application's own SDL. The @Module decorator is
// applied as a function call so the test suite does not need
// experimentalDecorators.
class AppModule {}
Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typeDefs: [federationTypeDefsSDL, typeDefs].join("\n\n"),
      resolvers,
      playground: false,
    }),
  ],
})(AppModule);

describe("@nestjs/graphql (ApolloDriver, schema-first)", () => {
  let app: INestApplication;
  let url: string;
  let schemaUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });

    // Registered before init so it precedes the Apollo middleware, which is
    // mounted with a prefix match on /graphql and would swallow the route.
    // The handler is created lazily because the schema Nest builds only
    // exists after initialization.
    let schemaHandler: SourceSchemaHandler | undefined;

    app.use(
      "/graphql/schema.graphql",
      (req: IncomingMessage, res: ServerResponse) => {
        schemaHandler ??= createSourceSchemaHandler(
          app.get(GraphQLSchemaHost).schema,
        );
        schemaHandler(req, res);
      },
    );

    await app.listen(0, "127.0.0.1");
    const httpServer = app.getHttpServer() as Server;
    const { port } = httpServer.address() as AddressInfo;
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
