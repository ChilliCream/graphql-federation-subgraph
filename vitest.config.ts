import { defineConfig } from "vitest/config";

// graphql@16 ships CJS + ESM entry points without an "exports" map. Vite
// resolves `graphql` to the ESM build for test files while Node loads the CJS
// build for externalized dependencies (the e2e servers: @apollo/server,
// graphql-yoga, mercurius, …), which produces two module realms and "Cannot
// use GraphQLSchema from another module or realm" errors. Pin the test runner
// to the CJS build that Node uses.
export default defineConfig({
  resolve: {
    alias: [{ find: /^graphql$/, replacement: "graphql/index.js" }],
  },
  test: {
    // The e2e tests boot real HTTP servers (NestJS in particular takes a
    // moment); give startup hooks room beyond the defaults.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
