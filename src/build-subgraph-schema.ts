import {
  buildASTSchema,
  Kind,
  parse,
  print,
  type ASTNode,
  type DefinitionNode,
  type DocumentNode,
  type GraphQLSchema,
  type TypeExtensionNode,
} from "graphql";
import { attachResolvers, type SubgraphResolvers } from "./attach-resolvers.js";
import { federationTypeDefs } from "./type-defs.js";

/**
 * The type definitions accepted by {@link buildSubgraphSchema}: SDL strings,
 * parsed documents, or arbitrarily nested arrays of either.
 */
export type SubgraphTypeSource =
  string | DocumentNode | readonly SubgraphTypeSource[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the context default of graphql-js resolver signatures
export interface BuildSubgraphSchemaOptions<TContext = any> {
  readonly typeDefs: SubgraphTypeSource;
  /**
   * Resolvers to wire into the schema: field resolvers, `__resolveType` /
   * `__isTypeOf` functions, custom scalar configs (or `GraphQLScalarType`
   * instances), and enum internal values. A single map or an array of maps.
   */
  readonly resolvers?:
    SubgraphResolvers<TContext> | readonly SubgraphResolvers<TContext>[];
  /**
   * Skips SDL validation of the type definitions. Forwarded to graphql-js's
   * `buildASTSchema`.
   */
  readonly assumeValidSDL?: boolean;
  /**
   * Marks the resulting schema as valid, skipping later `validateSchema`
   * checks. Forwarded to graphql-js's `buildASTSchema`.
   */
  readonly assumeValid?: boolean;
}

const SUPPORTED_OPTIONS = new Set<string>([
  "typeDefs",
  "resolvers",
  "assumeValid",
  "assumeValidSDL",
]);

/**
 * Builds an executable {@link GraphQLSchema} for a source schema (subgraph) as
 * defined by the GraphQL Federation Spec.
 *
 * The federation directive and scalar definitions (`@key`, `@lookup`, `@is`,
 * `FieldSelectionMap`, …) are added automatically, so type definitions can use
 * them without declaring them. Definitions the user already provides take
 * precedence and are never duplicated.
 *
 * The result is a plain `GraphQLSchema`, usable with any GraphQL server that
 * accepts one (GraphQL Yoga, Apollo Server, Mercurius, graphql-http, …).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the context default of graphql-js resolver signatures
export function buildSubgraphSchema<TContext = any>(
  options: BuildSubgraphSchemaOptions<TContext>,
): GraphQLSchema {
  for (const key of Object.keys(options)) {
    if (!SUPPORTED_OPTIONS.has(key)) {
      // Loud rather than silent for JavaScript callers migrating resolver
      // setups that passed makeExecutableSchema options (e.g.
      // resolverValidationOptions, inheritResolversFromInterfaces), which
      // this package does not support.
      throw new Error(
        `buildSubgraphSchema: unknown option "${key}". Supported options: typeDefs, resolvers, assumeValid, assumeValidSDL.`,
      );
    }
  }

  const documents = convertBaselessExtensions(
    normalizeTypeDefs(options.typeDefs),
  );
  const definitions = mergeDuplicateDefinitions(
    documents.flatMap((doc) => doc.definitions),
  );
  const provided = collectDefinedNames(definitions);

  const missingDefinitions = federationTypeDefs.definitions.filter(
    (definition) => isMissing(definition, provided),
  );

  const document: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [...definitions, ...missingDefinitions],
  };

  const schema = buildASTSchema(document, {
    assumeValidSDL: options.assumeValidSDL,
    assumeValid: options.assumeValid,
  });

  const resolvers =
    options.resolvers === undefined
      ? []
      : Array.isArray(options.resolvers)
        ? options.resolvers
        : [options.resolvers as SubgraphResolvers<TContext>];

  return attachResolvers(schema, resolvers);
}

// Modular typeDefs arrays commonly repeat a definition — a `type Query` per
// module, or the federation definitions imported by several modules. SDL
// validation rejects duplicate names, so same-kind duplicates are merged into
// one definition first: member lists and directives are concatenated with
// exact duplicates (by printed form) dropped, while genuine conflicts (same
// field with different types, same-named definitions of different kinds) are
// left for SDL validation to report.
function mergeDuplicateDefinitions(
  definitions: readonly DefinitionNode[],
): DefinitionNode[] {
  const merged: DefinitionNode[] = [];
  const indexByName = new Map<string, number>();

  for (const definition of definitions) {
    const name = definitionName(definition);

    if (name === undefined) {
      merged.push(definition);
      continue;
    }

    const existingIndex = indexByName.get(name);
    const existing =
      existingIndex === undefined ? undefined : merged[existingIndex];

    if (existingIndex === undefined || existing === undefined) {
      indexByName.set(name, merged.length);
      merged.push(definition);
      continue;
    }

    if (existing.kind !== definition.kind) {
      merged.push(definition);
      continue;
    }

    if (definition.kind === Kind.DIRECTIVE_DEFINITION) {
      // A duplicate that differs only in its description is the same
      // definition; keep the copy that carries the description.
      if (strippedPrint(existing) !== strippedPrint(definition)) {
        merged.push(definition);
      } else if (
        (existing as { description?: unknown }).description == null &&
        definition.description != null
      ) {
        merged[existingIndex] = definition;
      }

      continue;
    }

    merged[existingIndex] = mergeDefinitionPair(existing, definition);
  }

  return merged;
}

function definitionName(definition: DefinitionNode): string | undefined {
  if (definition.kind === Kind.DIRECTIVE_DEFINITION) {
    return `directive:${definition.name.value}`;
  }

  if (isTypeDefinition(definition)) {
    return `type:${definition.name.value}`;
  }

  if (definition.kind === Kind.SCHEMA_DEFINITION) {
    return "schema";
  }

  if (definition.kind === Kind.SCHEMA_EXTENSION) {
    // Identical schema extensions collapse; distinct ones stay separate
    // (multiple `extend schema` blocks are valid SDL).
    return `schema-extension:${print(definition)}`;
  }

  return undefined;
}

// Printed form with the top-level description removed, so duplicates that
// differ only in documentation compare as equal.
function strippedPrint(node: ASTNode): string {
  return print({ ...node, description: undefined } as ASTNode);
}

const MERGED_MEMBER_PROPS: readonly string[] = [
  "directives",
  "fields",
  "interfaces",
  "values",
  "types",
  "operationTypes",
];

function mergeDefinitionPair(
  first: DefinitionNode,
  second: DefinitionNode,
): DefinitionNode {
  const merged: Record<string, unknown> = { ...first };
  const firstDescription = (first as { description?: unknown }).description;
  const secondDescription = (second as { description?: unknown }).description;

  if (firstDescription == null && secondDescription != null) {
    merged.description = secondDescription;
  }

  for (const prop of MERGED_MEMBER_PROPS) {
    const left =
      (first as unknown as Record<string, readonly ASTNode[]>)[prop] ?? [];
    const right =
      (second as unknown as Record<string, readonly ASTNode[]>)[prop] ?? [];

    if (left.length === 0 && right.length === 0) {
      continue;
    }

    // Members are compared with descriptions stripped, so duplicates that
    // differ only in documentation merge instead of colliding; the copy
    // carrying a description wins.
    const combined: ASTNode[] = [];
    const indexByKey = new Map<string, number>();

    for (const node of [...left, ...right]) {
      const key = strippedPrint(node);
      const existingIndex = indexByKey.get(key);
      const existing =
        existingIndex === undefined ? undefined : combined[existingIndex];

      if (existingIndex === undefined || existing === undefined) {
        indexByKey.set(key, combined.length);
        combined.push(node);
      } else if (
        (existing as { description?: unknown }).description == null &&
        (node as { description?: unknown }).description != null
      ) {
        combined[existingIndex] = node;
      }
    }

    merged[prop] = combined;
  }

  return merged as unknown as DefinitionNode;
}

function normalizeTypeDefs(typeDefs: SubgraphTypeSource): DocumentNode[] {
  if (typeof typeDefs === "string") {
    return [parse(typeDefs)];
  }

  if (isDocumentNode(typeDefs)) {
    return [typeDefs];
  }

  if (Array.isArray(typeDefs)) {
    // Array.isArray narrows the readonly-array union to any[], so the entry
    // type has to be restated.
    return typeDefs.flatMap((entry: SubgraphTypeSource) =>
      normalizeTypeDefs(entry),
    );
  }

  throw new TypeError(
    "buildSubgraphSchema: `typeDefs` must be an SDL string, a DocumentNode, or an array of those.",
  );
}

function isDocumentNode(value: unknown): value is DocumentNode {
  return (
    typeof value === "object" &&
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
    const definitions = document.definitions.map(
      (definition): DefinitionNode => {
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

        return {
          ...definition,
          kind: definitionKind,
        } as unknown as DefinitionNode;
      },
    );

    return changed ? { kind: Kind.DOCUMENT, definitions } : document;
  });
}

interface DefinedNames {
  readonly directives: Set<string>;
  readonly types: Set<string>;
}

function collectDefinedNames(
  definitions: readonly DefinitionNode[],
): DefinedNames {
  const directives = new Set<string>();
  const types = new Set<string>();

  for (const definition of definitions) {
    if (definition.kind === Kind.DIRECTIVE_DEFINITION) {
      directives.add(definition.name.value);
    } else if (isTypeDefinition(definition)) {
      types.add(definition.name.value);
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

function isMissing(
  definition: DefinitionNode,
  provided: DefinedNames,
): boolean {
  if (definition.kind === Kind.DIRECTIVE_DEFINITION) {
    return !provided.directives.has(definition.name.value);
  }

  if (definition.kind === Kind.SCALAR_TYPE_DEFINITION) {
    return !provided.types.has(definition.name.value);
  }

  return true;
}
