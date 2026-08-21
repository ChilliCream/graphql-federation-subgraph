import {
  Kind,
  print,
  visit,
  type DefinitionNode,
  type DirectiveDefinitionNode,
  type GraphQLSchema,
  type ScalarTypeDefinitionNode,
} from "graphql";
import { getDocumentFromSchema } from "./get-document-from-schema.js";
import { federationTypeDefs } from "./type-defs.js";

/**
 * Which of the GraphQL Federation Spec's definitions (`directive @key …`,
 * `scalar FieldSelectionMap`, …) `printSourceSchema` emits alongside the
 * user-authored schema:
 *
 * - `"used"` (the default): the definitions of the spec directives that are
 *   actually applied somewhere in the schema, plus the spec scalars the
 *   printed document references — whether from an exported directive
 *   definition or from the user's own definitions. As long as the spec is not
 *   officially released, tooling cannot be assumed to know these definitions
 *   as built-ins, so the used ones must travel with the schema document — the
 *   output is self-contained SDL that plain `buildSchema` accepts, without
 *   dragging in definitions nothing uses.
 * - `"all"`: every spec definition, used or not.
 * - `"none"`: only the user-authored schema with the federation directives
 *   applied — for tooling that already treats the spec definitions as
 *   built-ins, the way the released spec will mandate.
 *
 * A spec definition the schema itself lacks is supplied from the spec — a
 * directive applied through the `extensions.directives` convention without
 * being registered on the schema still prints with its definition, so the
 * output stays self-contained.
 *
 * In every mode, only definitions that structurally match the spec are
 * subject to this choice. A same-named definition the user customized (e.g.
 * `@key` with an extra argument, which the spec explicitly allows) is always
 * kept, so the printed SDL always describes the schema faithfully. Every mode
 * round-trips through `buildSubgraphSchema({ typeDefs: printSourceSchema(schema) })`.
 */
export type FederationDefinitionsMode = "used" | "all" | "none";

export interface PrintSourceSchemaOptions {
  /**
   * Which spec definitions to emit — see {@link FederationDefinitionsMode}.
   * Defaults to `"used"`.
   */
  readonly federationDefinitions?: FederationDefinitionsMode;
}

/**
 * Prints the SDL of a source schema (subgraph) *including* applied federation
 * directives such as `@key`, `@lookup`, or `@shareable` — which the standard
 * `printSchema` from graphql-js would drop. Use this to export the schema
 * document that composition tooling consumes.
 *
 * Exported spec definitions print as one block below the schema block (when
 * one is printed), ahead of the remaining definitions and in the spec's own
 * order, so equivalent schemas produce identical documents no matter how a
 * server framework assembled them.
 */
export function printSourceSchema(
  schema: GraphQLSchema,
  options: PrintSourceSchemaOptions = {},
): string {
  const document = getDocumentFromSchema(schema);
  const definitions = selectPrintedDefinitions(
    document.definitions,
    options.federationDefinitions ?? "used",
  );

  return print({ kind: Kind.DOCUMENT, definitions }) + "\n";
}

function selectPrintedDefinitions(
  documentDefinitions: readonly DefinitionNode[],
  mode: FederationDefinitionsMode,
): DefinitionNode[] {
  const definitions = documentDefinitions.filter(
    (definition) => !isRedundantSchemaDefinition(definition),
  );

  if (mode === "none") {
    return definitions.filter((definition) => !isSpecDefinition(definition));
  }

  return hoistSpecDefinitions(
    mode === "all"
      ? withAllSpecDefinitions(definitions)
      : selectUsedDefinitions(definitions),
  );
}

function withAllSpecDefinitions(
  definitions: readonly DefinitionNode[],
): DefinitionNode[] {
  const defined = getDefinedNames(definitions);

  return [
    ...definitions,
    ...specDefinitionNodes.filter((node) =>
      node.kind === Kind.DIRECTIVE_DEFINITION
        ? !defined.directives.has(node.name.value)
        : !defined.types.has(node.name.value),
    ),
  ];
}

function selectUsedDefinitions(
  definitions: readonly DefinitionNode[],
): DefinitionNode[] {
  // A spec directive definition is kept when the directive is applied
  // somewhere in the schema. Applications can only sit on user-authored
  // definitions (spec-matching definitions carry none), so the whole document
  // can be scanned before filtering.
  const appliedDirectiveNames = new Set<string>();

  visit(
    { kind: Kind.DOCUMENT, definitions },
    {
      Directive(node): void {
        appliedDirectiveNames.add(node.name.value);
      },
    },
  );

  const defined = getDefinedNames(definitions);

  // A spec directive applied without any definition in the schema — e.g.
  // through the `extensions.directives` convention without registering the
  // directive — gets the spec's definition injected, keeping the output
  // self-contained.
  const injectedDirectives = specDefinitionNodes.filter(
    (node): node is DirectiveDefinitionNode =>
      node.kind === Kind.DIRECTIVE_DEFINITION &&
      appliedDirectiveNames.has(node.name.value) &&
      !defined.directives.has(node.name.value),
  );

  const keptExceptSpecScalars = [
    ...definitions.filter((definition) => {
      if (!isSpecDefinition(definition)) {
        return true;
      }

      return (
        definition.kind === Kind.DIRECTIVE_DEFINITION &&
        appliedDirectiveNames.has(definition.name.value)
      );
    }),
    ...injectedDirectives,
  ];

  // A spec scalar definition is kept when a kept definition references it —
  // `FieldSelectionMap` travels with a kept `@is`/`@require` definition, and
  // with any user-authored definition that names it directly. A referenced
  // spec scalar the schema never defined is injected from the spec.
  const referencedTypeNames = new Set<string>();

  visit(
    { kind: Kind.DOCUMENT, definitions: keptExceptSpecScalars },
    {
      NamedType(node): void {
        referencedTypeNames.add(node.name.value);
      },
    },
  );

  const injectedScalars = specDefinitionNodes.filter(
    (node): node is ScalarTypeDefinitionNode =>
      node.kind === Kind.SCALAR_TYPE_DEFINITION &&
      referencedTypeNames.has(node.name.value) &&
      !defined.types.has(node.name.value),
  );

  return [
    ...definitions.filter((definition) => {
      if (!isSpecDefinition(definition)) {
        return true;
      }

      if (definition.kind === Kind.SCALAR_TYPE_DEFINITION) {
        return referencedTypeNames.has(definition.name.value);
      }

      return appliedDirectiveNames.has(definition.name.value);
    }),
    ...injectedDirectives,
    ...injectedScalars,
  ];
}

interface DefinedNames {
  readonly directives: Set<string>;
  readonly types: Set<string>;
}

function getDefinedNames(definitions: readonly DefinitionNode[]): DefinedNames {
  const directives = new Set<string>();
  const types = new Set<string>();

  for (const definition of definitions) {
    if (definition.kind === Kind.DIRECTIVE_DEFINITION) {
      directives.add(definition.name.value);
    } else if ("name" in definition && definition.name?.kind === Kind.NAME) {
      types.add(definition.name.value);
    }
  }

  return { directives, types };
}

// Where a spec definition lands in the assembled document depends on the
// schema's directive and type-map order, which varies with how a server
// framework assembled the schema. Printing the spec definitions as one block
// below the schema block, in the spec's own order, keeps the printed document
// identical for equivalent schemas.
function hoistSpecDefinitions(
  definitions: readonly DefinitionNode[],
): DefinitionNode[] {
  const specNodes: (DirectiveDefinitionNode | ScalarTypeDefinitionNode)[] = [];
  const rest: DefinitionNode[] = [];

  for (const definition of definitions) {
    if (isSpecDefinition(definition)) {
      specNodes.push(definition);
    } else {
      rest.push(definition);
    }
  }

  specNodes.sort((left, right) => getSpecOrder(left) - getSpecOrder(right));

  const schemaBlockCount =
    rest[0]?.kind === Kind.SCHEMA_DEFINITION ||
    rest[0]?.kind === Kind.SCHEMA_EXTENSION
      ? 1
      : 0;

  return [
    ...rest.slice(0, schemaBlockCount),
    ...specNodes,
    ...rest.slice(schemaBlockCount),
  ];
}

interface SpecDefinitionEntry {
  readonly sdl: string;
  readonly order: number;
}

// The spec's definition nodes in spec order, and their printed form keyed by
// node kind + name so schema definitions can be compared structurally rather
// than by name alone; `order` is the definition's position in the spec SDL,
// used to print the exported definitions in a stable order.
const specDefinitionNodes: (
  DirectiveDefinitionNode | ScalarTypeDefinitionNode
)[] = [];
const specDefinitions = new Map<string, SpecDefinitionEntry>();

for (const definition of federationTypeDefs.definitions) {
  if (
    definition.kind === Kind.DIRECTIVE_DEFINITION ||
    definition.kind === Kind.SCALAR_TYPE_DEFINITION
  ) {
    specDefinitions.set(`${definition.kind}:${definition.name.value}`, {
      sdl: print(definition),
      order: specDefinitionNodes.length,
    });
    specDefinitionNodes.push(definition);
  }
}

function isSpecDefinition(
  definition: DefinitionNode,
): definition is DirectiveDefinitionNode | ScalarTypeDefinitionNode {
  if (
    definition.kind !== Kind.DIRECTIVE_DEFINITION &&
    definition.kind !== Kind.SCALAR_TYPE_DEFINITION
  ) {
    return false;
  }

  const expected = specDefinitions.get(
    `${definition.kind}:${definition.name.value}`,
  );

  if (expected === undefined) {
    return false;
  }

  // Descriptions don't change what the definition means to composition.
  return print({ ...definition, description: undefined }) === expected.sdl;
}

function getSpecOrder(
  definition: DirectiveDefinitionNode | ScalarTypeDefinitionNode,
): number {
  return (
    specDefinitions.get(`${definition.kind}:${definition.name.value}`)?.order ??
    0
  );
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
