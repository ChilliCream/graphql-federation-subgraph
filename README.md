# graphql-federation-subgraph

Federation directives from the [GraphQL Composite Schemas Spec](https://github.com/graphql/composite-schemas-spec) for **any** TypeScript/JavaScript GraphQL server.

This package plays the same role for the Composite Schemas Spec that [`@apollo/subgraph`](https://www.npmjs.com/package/@apollo/subgraph) plays for Apollo Federation: it lets a service use the federation directives (`@key`, `@lookup`, `@shareable`, …) in its schema without defining them, and export its schema for composition. Unlike `@apollo/subgraph`, it is not tied to any particular server — the result is a plain `GraphQLSchema`, so it works with GraphQL Yoga, Apollo Server, Mercurius, `graphql-http`, and anything else that accepts one.

## Why there are no reference resolvers

In Apollo Federation, a subgraph implements a side-channel protocol: the router calls `Query._entities` with opaque representations, and each entity needs a `__resolveReference` resolver. The Composite Schemas Spec has no such protocol. Entity resolution happens through **ordinary fields** annotated with `@lookup`:

```graphql
type Query {
  productById(id: ID!): Product @lookup
}
```

`productById` is a regular field with a regular resolver — the distributed executor simply calls it. That means this package needs no `_entities`, `_Any`, `_service`, or `__resolveReference` machinery at all; it only manages directive definitions and schema export.

## Installation

```sh
npm install graphql-federation-subgraph graphql
```

`graphql` `^16.11.0 || ^17.0.0` is a peer dependency.

## Quick start

```ts
import { buildSubgraphSchema } from 'graphql-federation-subgraph';

const typeDefs = /* GraphQL */ `
  type Query {
    productById(id: ID!): Product @lookup
    productBySku(sku: String! @is(field: "sku")): Product @lookup
  }

  type Product @key(fields: "id") @key(fields: "sku") {
    id: ID!
    sku: String!
    name: String!
  }
`;

const products = [
  { id: '1', sku: 'A-1', name: 'Chair' },
  { id: '2', sku: 'B-2', name: 'Table' },
];

const resolvers = {
  Query: {
    productById: (_parent: unknown, args: { id: string }) =>
      products.find((product) => product.id === args.id),
    productBySku: (_parent: unknown, args: { sku: string }) =>
      products.find((product) => product.sku === args.sku),
  },
};

const schema = buildSubgraphSchema({ typeDefs, resolvers });
```

All federation directive and scalar definitions are added automatically; definitions you provide yourself take precedence and are never duplicated.

### GraphQL Yoga

```ts
import { createServer } from 'node:http';
import { createYoga } from 'graphql-yoga';

const yoga = createYoga({ schema });
createServer(yoga).listen(4000);
```

### Apollo Server

```ts
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';

const server = new ApolloServer({ schema });
await startStandaloneServer(server, { listen: { port: 4000 } });
```

### Mercurius (Fastify)

```ts
import Fastify from 'fastify';
import mercurius from 'mercurius';

const app = Fastify();
app.register(mercurius, { schema });
await app.listen({ port: 4000 });
```

### graphql-http

```ts
import { createHandler } from 'graphql-http/lib/use/http';
import { createServer } from 'node:http';

createServer(createHandler({ schema })).listen(4000);
```

### NestJS

With schema-first drivers, contribute the federation definitions alongside your own type definitions:

```ts
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { federationTypeDefsSDL } from 'graphql-federation-subgraph';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typeDefs: [federationTypeDefsSDL, typeDefs].join('\n\n'),
      resolvers,
    }),
  ],
})
export class AppModule {}
```

Code-first (decorator-based) schemas need directive support from the schema builder itself.

## Exporting the schema for composition

Composition tooling needs your schema *with the federation directives applied* — which the standard `printSchema` from graphql-js silently drops. Use `printSubgraphSchema` instead:

```ts
import { writeFileSync } from 'node:fs';
import { printSubgraphSchema } from 'graphql-federation-subgraph';

writeFileSync('products.graphql', printSubgraphSchema(schema));
```

By default the output contains only your own definitions with the directives applied — the spec treats the federation directives and scalars as built-ins that composers already know, so the output round-trips cleanly through `buildSubgraphSchema`. Only definitions that structurally match the spec are omitted; if you customized one (say, `@key` with an extra argument, which the spec allows), it stays in the output. Pass `{ includeFederationDefinitions: true }` to emit self-contained SDL that plain `buildSchema` accepts.

## Directive reference

| Directive | Definition | Purpose |
| --- | --- | --- |
| `@lookup` | `on FIELD_DEFINITION` | Marks a field the distributed executor can use to resolve an entity by key. |
| `@internal` | `on OBJECT \| FIELD_DEFINITION` | Hides a member from the composite schema and from merging; usable only by the executor (e.g. internal lookups). |
| `@inaccessible` | `on FIELD_DEFINITION \| OBJECT \| …` | Globally hides a member from the client-facing composite schema. |
| `@is(field: FieldSelectionMap!)` | `on ARGUMENT_DEFINITION` | Maps a lookup argument to fields of the entity it resolves. |
| `@require(field: FieldSelectionMap!)` | `on ARGUMENT_DEFINITION` | Declares an argument the executor fulfills with data from other source schemas. |
| `@key(fields: FieldSelectionSet!)` | `repeatable on OBJECT \| INTERFACE` | Declares a stable key that identifies an entity across source schemas. |
| `@shareable` | `repeatable on OBJECT \| FIELD_DEFINITION` | Allows a field to be contributed by multiple source schemas. |
| `@provides(fields: FieldSelectionSet!)` | `on FIELD_DEFINITION` | Declares subfields of the return type this field can resolve locally. |
| `@external` | `on FIELD_DEFINITION` | Marks a field recognized but not resolved by this source schema. |
| `@override(from: String!)` | `on FIELD_DEFINITION` | Migrates a field from another source schema to this one. |
| `@interfaceObject` ⚠️ | `on OBJECT` | Object type standing in for an interface owned by another source schema. |
| `@implement` ⚠️ | `on FIELD_DEFINITION` | Explicit replacement for a field projected from an `@interfaceObject` stand-in. |

⚠️ `@interfaceObject` and `@implement` are **provisional**: they come from the open spec PR [graphql/composite-schemas-spec#233](https://github.com/graphql/composite-schemas-spec/pull/233) and their names or semantics may change before the PR is merged.

## API

- **`buildSubgraphSchema(options)`** — builds an executable `GraphQLSchema` from `typeDefs` (SDL string, `DocumentNode`, or nested arrays of either) and `resolvers`, injecting any federation definitions the document doesn't already define. Additional options are forwarded to [`makeExecutableSchema`](https://the-guild.dev/graphql/tools/docs/generate-schema).
- **`printSubgraphSchema(schema, options?)`** — prints SDL including applied federation directives. `options.includeFederationDefinitions` (default `false`) controls whether the spec's directive/scalar definitions are emitted.
- **`federationTypeDefs`** / **`federationTypeDefsSDL`** — the definitions as a `DocumentNode` / SDL string, for wiring into your own schema-building pipeline (e.g. `makeExecutableSchema({ typeDefs: [federationTypeDefs, typeDefs] })`).
- **`federationDirectives`**, **`lookupDirective`**, **`keyDirective`**, … — `GraphQLDirective` instances for code-first schemas (`new GraphQLSchema({ …, directives: [...specifiedDirectives, ...federationDirectives] })`).
- **`fieldSelectionMapScalar`** / **`fieldSelectionSetScalar`** — the spec's scalar types.
- **`federationDirectiveNames`** / **`federationScalarNames`** — the injected names.

## Comparison with `@apollo/subgraph`

|  | `graphql-federation-subgraph` | `@apollo/subgraph` |
| --- | --- | --- |
| Specification | [Composite Schemas Spec](https://github.com/graphql/composite-schemas-spec) (GraphQL Foundation) | Apollo Federation |
| Entity resolution | Ordinary `@lookup` fields with ordinary resolvers | `Query._entities` + `__resolveReference` |
| Schema exposure | `printSubgraphSchema` → file for composition | Runtime `Query._service { sdl }` |
| Injected runtime types | None | `_Service`, `_Entity`, `_Any`, `_service`, `_entities` |
| Spec linking | None needed (bare directive names) | `@link` imports (Federation 2) |

## License

MIT © Copyright (c) 2018 - present ChilliCream Inc.
