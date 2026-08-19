import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from 'graphql-http/lib/use/http';
import { buildSubgraphSchema } from '../index.js';
import { expectedData, postGraphQL, resolvers, typeDefs } from './fixture.js';

describe('graphql-http', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer(
      createHandler({ schema: buildSubgraphSchema({ typeDefs, resolvers }) }),
    );
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

  it('serves the subgraph schema over HTTP', async () => {
    const result = await postGraphQL(url);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual(expectedData);
  });
});
