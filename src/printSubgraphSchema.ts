import { Kind, print, type DefinitionNode, type GraphQLSchema } from 'graphql';
import { getDocumentNodeFromSchema } from '@graphql-tools/utils';
import { federationTypeDefs } from './typeDefs.js';

export interface PrintSubgraphSchemaOptions {
  /**
   * When `true`, the definitions of the spec's federation directives and
   * scalars (`directive @key …`, `scalar FieldSelectionMap`, …) are included,
   * producing self-contained SDL that `buildSchema` accepts as-is.
   *
   * Defaults to `false`: the composite schemas spec treats these definitions
   * as built-ins that composition tooling already knows, so by default the
   * output contains only the user-authored schema with the federation
   * directives applied — and round-trips through
   * `buildSubgraphSchema({ typeDefs: printSubgraphSchema(schema) })`.
   *
   * Only definitions that structurally match the spec are omitted. A
   * same-named definition the user customized (e.g. `@key` with an extra
   * argument, which the spec explicitly allows) is kept, so the printed SDL
   * always describes the schema faithfully.
   */
  includeFederationDefinitions?: boolean;
}

/**
 * Prints the SDL of a source schema (subgraph) *including* applied federation
 * directives such as `@key`, `@lookup`, or `@shareable` — which the standard
 * `printSchema` from graphql-js would drop. Use this to export the schema
 * document that composition tooling consumes.
 */
export function printSubgraphSchema(
  schema: GraphQLSchema,
  options: PrintSubgraphSchemaOptions = {},
): string {
  const document = getDocumentNodeFromSchema(schema);

  const definitions = document.definitions.filter((definition) => {
    if (isRedundantSchemaDefinition(definition)) {
      return false;
    }
    if (options.includeFederationDefinitions) {
      return true;
    }
    return !isSpecDefinition(definition);
  });

  return print({ kind: Kind.DOCUMENT, definitions }) + '\n';
}

// The spec's definitions in printed form, keyed by node kind + name, so
// schema definitions can be compared structurally rather than by name alone.
const specDefinitionSDL = new Map<string, string>();
for (const definition of federationTypeDefs.definitions) {
  if (
    definition.kind === Kind.DIRECTIVE_DEFINITION ||
    definition.kind === Kind.SCALAR_TYPE_DEFINITION
  ) {
    specDefinitionSDL.set(
      `${definition.kind}:${definition.name.value}`,
      print(definition),
    );
  }
}

function isSpecDefinition(definition: DefinitionNode): boolean {
  if (
    definition.kind !== Kind.DIRECTIVE_DEFINITION &&
    definition.kind !== Kind.SCALAR_TYPE_DEFINITION
  ) {
    return false;
  }
  const expected = specDefinitionSDL.get(
    `${definition.kind}:${definition.name.value}`,
  );
  if (expected === undefined) {
    return false;
  }
  // Descriptions don't change what the definition means to composition.
  return print({ ...definition, description: undefined }) === expected;
}

// Mirrors printSchema's behavior of omitting `schema { query: Query … }` when
// it carries no description or directives and all root types use their
// default names.
function isRedundantSchemaDefinition(definition: DefinitionNode): boolean {
  if (definition.kind !== Kind.SCHEMA_DEFINITION) {
    return false;
  }
  if (definition.description || definition.directives?.length) {
    return false;
  }
  return (definition.operationTypes ?? []).every((operationType) => {
    const operation = operationType.operation;
    const defaultName = operation.charAt(0).toUpperCase() + operation.slice(1);
    return operationType.type.name.value === defaultName;
  });
}
