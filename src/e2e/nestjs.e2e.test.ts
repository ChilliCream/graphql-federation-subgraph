import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { federationTypeDefsSDL } from '../index.js';
import { expectedData, postGraphQL, resolvers, typeDefs } from './fixture.js';

// Schema-first NestJS: the federation definitions are contributed as plain
// typeDefs next to the application's own SDL. The @Module decorator is
// applied as a function call so the test suite does not need
// experimentalDecorators.
class AppModule {}
Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typeDefs: [federationTypeDefsSDL, typeDefs].join('\n\n'),
      resolvers,
      playground: false,
    }),
  ],
})(AppModule);

describe('@nestjs/graphql (ApolloDriver, schema-first)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${port}/graphql`;
  });

  afterAll(() => app.close());

  it('serves the subgraph schema over HTTP', async () => {
    const result = await postGraphQL(url);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual(expectedData);
  });
});
