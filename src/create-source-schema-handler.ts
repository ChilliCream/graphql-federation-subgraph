import type { GraphQLSchema } from "graphql";
import {
  printSourceSchema,
  type PrintSourceSchemaOptions,
} from "./print-source-schema.js";

/**
 * The part of an incoming HTTP request the source schema handler reads. The
 * shape is structural on purpose: Node's `IncomingMessage`, Express's
 * `Request`, and Fastify's `request.raw` all satisfy it, without this package
 * depending on Node.js types.
 */
export interface SourceSchemaRequest {
  readonly method?: string | undefined;
}

/* eslint-disable no-restricted-syntax -- `statusCode` is assigned by the
   handler, mirroring Node's mutable `ServerResponse.statusCode` */
/**
 * The part of an HTTP response the source schema handler writes. Node's
 * `ServerResponse`, Express's `Response`, and Fastify's `reply.raw` all
 * satisfy it.
 */
export interface SourceSchemaResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}
/* eslint-enable no-restricted-syntax */

/**
 * The handler `createSourceSchemaHandler` returns: serves the source schema
 * document to any request/response pair satisfying the structural types
 * above.
 */
export type SourceSchemaHandler = (
  request: SourceSchemaRequest,
  response: SourceSchemaResponse,
) => void;

/**
 * Creates an HTTP handler that serves `printSourceSchema(schema, options)` —
 * the source schema document with applied federation directives — as
 * `application/graphql`, the counterpart of Hot Chocolate's SDL endpoint for
 * schema-document tooling. Mount it under the GraphQL endpoint by convention,
 * e.g. `/graphql/schema.graphql`; routing is the server's job, the handler
 * answers every request it is given (`GET` and `HEAD` with the document,
 * anything else with `405 Method Not Allowed`).
 *
 * The document is printed once, when the handler is created.
 *
 * Like introspection, the endpoint reveals the full schema — a deployment
 * that disables introspection should gate or omit this endpoint the same
 * way.
 */
export function createSourceSchemaHandler(
  schema: GraphQLSchema,
  options: PrintSourceSchemaOptions = {},
): SourceSchemaHandler {
  const sdl = printSourceSchema(schema, options);
  const contentLength = String(new TextEncoder().encode(sdl).length);

  return (request, response) => {
    const method = request.method?.toUpperCase();

    if (method !== "GET" && method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", "GET, HEAD");
      response.end();

      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "application/graphql; charset=utf-8");
    response.setHeader("content-length", contentLength);
    response.end(method === "HEAD" ? undefined : sdl);
  };
}
