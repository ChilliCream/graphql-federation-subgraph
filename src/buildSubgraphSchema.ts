import {
  Kind,
  parse,
  type DefinitionNode,
  type DocumentNode,
  type GraphQLSchema,
  type TypeExtensionNode,
} from 'graphql';
import {
  makeExecutableSchema,
  type IExecutableSchemaDefinition,
} from '@graphql-tools/schema';
import { federationTypeDefs } from './typeDefs.js';

/**
 * The type definitions accepted by {@link buildSubgraphSchema}: SDL strings,
 * parsed documents, or arbitrarily nested arrays of either.
 */
export type SubgraphTypeSource =
  | string
  | DocumentNode
  | ReadonlyArray<SubgraphTypeSource>;

export interface BuildSubgraphSchemaOptions<TContext = any>
  extends Omit<IExecutableSchemaDefinition<TContext>, 'typeDefs'> {
  readonly typeDefs: SubgraphTypeSource;
}

/**
 * Builds an executable {@link GraphQLSchema} for a source schema (subgraph) as
 * defined by the GraphQL Composite Schemas Spec.
 *
 * The federation directive and scalar definitions (`@key`, `@lookup`, `@is`,
 * `FieldSelectionMap`, …) are added automatically, so type definitions can use
 * them without declaring them. Definitions the user already provides take
 * precedence and are never duplicated.
 *
 * The result is a plain `GraphQLSchema`, usable with any GraphQL server that
 * accepts one (GraphQL Yoga, Apollo Server, Mercurius, graphql-http, …).
 */
export function buildSubgraphSchema<TContext = any>(
  options: BuildSubgraphSchemaOptions<TContext>,
): GraphQLSchema {
  const documents = convertBaselessExtensions(normalizeTypeDefs(options.typeDefs));
  const provided = collectDefinedNames(documents);

  const missingDefinitions = federationTypeDefs.definitions.filter((definition) =>
    isMissing(definition, provided),
  );

  const typeDefs: DocumentNode[] =
    missingDefinitions.length > 0
      ? [...documents, { kind: Kind.DOCUMENT, definitions: missingDefinitions }]
      : [...documents];

  return makeExecutableSchema({ ...options, typeDefs });
}

function normalizeTypeDefs(typeDefs: SubgraphTypeSource): DocumentNode[] {
  if (typeof typeDefs === 'string') {
    return [parse(typeDefs)];
  }
  if (isDocumentNode(typeDefs)) {
    return [typeDefs];
  }
  if (Array.isArray(typeDefs)) {
    return typeDefs.flatMap((entry) => normalizeTypeDefs(entry));
  }
  throw new TypeError(
    'buildSubgraphSchema: `typeDefs` must be an SDL string, a DocumentNode, or an array of those.',
  );
}

function isDocumentNode(value: unknown): value is DocumentNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as DocumentNode).kind === Kind.DOCUMENT
  );
}

const EXTENSION_TO_DEFINITION: Partial<Record<string, Kind>> = {
  [Kind.SCALAR_TYPE_EXTENSION]: Kind.SCALAR_TYPE_DEFINITION,
  [Kind.OBJECT_TYPE_EXTENSION]: Kind.OBJECT_TYPE_DEFINITION,
  [Kind.INTERFACE_TYPE_EXTENSION]: Kind.INTERFACE_TYPE_DEFINITION,
  [Kind.UNION_TYPE_EXTENSION]: Kind.UNION_TYPE_DEFINITION,
  [Kind.ENUM_TYPE_EXTENSION]: Kind.ENUM_TYPE_DEFINITION,
  [Kind.INPUT_OBJECT_TYPE_EXTENSION]: Kind.INPUT_OBJECT_TYPE_DEFINITION,
};

// Subgraph SDL commonly uses `extend type Query { … }` without defining a
// base Query type (the idiom @apollo/subgraph accepts). extendSchema rejects
// extensions of undefined types, so the first extension of a type that has no
// definition anywhere in the provided documents is turned into the
// definition; further extensions of it then merge normally.
function convertBaselessExtensions(documents: DocumentNode[]): DocumentNode[] {
  const definedTypeNames = new Set<string>();
  for (const document of documents) {
    for (const definition of document.definitions) {
      if (isTypeDefinition(definition)) {
        definedTypeNames.add(definition.name.value);
      }
    }
  }

  return documents.map((document) => {
    let changed = false;
    const definitions = document.definitions.map((definition): DefinitionNode => {
      const definitionKind = EXTENSION_TO_DEFINITION[definition.kind];
      if (definitionKind === undefined) {
        return definition;
      }
      const name = (definition as TypeExtensionNode).name.value;
      if (definedTypeNames.has(name)) {
        return definition;
      }
      definedTypeNames.add(name);
      changed = true;
      return { ...definition, kind: definitionKind } as unknown as DefinitionNode;
    });
    return changed ? { kind: Kind.DOCUMENT, definitions } : document;
  });
}

interface DefinedNames {
  readonly directives: Set<string>;
  readonly types: Set<string>;
}

function collectDefinedNames(documents: readonly DocumentNode[]): DefinedNames {
  const directives = new Set<string>();
  const types = new Set<string>();
  for (const document of documents) {
    for (const definition of document.definitions) {
      if (definition.kind === Kind.DIRECTIVE_DEFINITION) {
        directives.add(definition.name.value);
      } else if (isTypeDefinition(definition)) {
        types.add(definition.name.value);
      }
    }
  }
  return { directives, types };
}

function isTypeDefinition(
  definition: DefinitionNode,
): definition is DefinitionNode & { name: { value: string } } {
  switch (definition.kind) {
    case Kind.SCALAR_TYPE_DEFINITION:
    case Kind.OBJECT_TYPE_DEFINITION:
    case Kind.INTERFACE_TYPE_DEFINITION:
    case Kind.UNION_TYPE_DEFINITION:
    case Kind.ENUM_TYPE_DEFINITION:
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
      return true;
    default:
      return false;
  }
}

function isMissing(definition: DefinitionNode, provided: DefinedNames): boolean {
  if (definition.kind === Kind.DIRECTIVE_DEFINITION) {
    return !provided.directives.has(definition.name.value);
  }
  if (definition.kind === Kind.SCALAR_TYPE_DEFINITION) {
    return !provided.types.has(definition.name.value);
  }
  return true;
}
