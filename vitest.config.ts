import { createRequire } from "node:module";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

// Vite resolves `graphql` to the ESM build for test files while Node loads
// the CJS build for externalized dependencies (the e2e servers:
// @apollo/server, graphql-yoga, mercurius, …), which produces two module
// realms and "Cannot use GraphQLSchema from another module or realm" errors.
// Pin the test runner to the exact CJS file Node uses; require.resolve keeps
// this correct across graphql@16 (no "exports" map) and graphql@17.
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: [{ find: /^graphql$/, replacement: require.resolve("graphql") }],
  },
  test: {
    // The e2e tests boot real HTTP servers (NestJS in particular takes a
    // moment); give startup hooks room beyond the defaults.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      include: ["src/**"],
      // The e2e directory is test infrastructure (server harnesses), not
      // library code under test.
      exclude: [...coverageConfigDefaults.exclude, "src/e2e/**"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
