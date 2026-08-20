import {
  DEFAULT_DEPRECATION_REASON,
  Kind,
  OperationTypeNode,
  astFromValue,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isListType,
  isNonNullType,
  isObjectType,
  isSpecifiedDirective,
  isSpecifiedScalarType,
  isUnionType,
  print,
  type ConstArgumentNode,
  type ConstDirectiveNode,
  type ConstObjectFieldNode,
  type ConstValueNode,
  type DefinitionNode,
  type DirectiveDefinitionNode,
  type DocumentNode,
  type EnumValueDefinitionNode,
  type FieldDefinitionNode,
  type GraphQLArgument,
  type GraphQLDirective,
  type GraphQLEnumValue,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLSchema,
  type GraphQLType,
  type InputValueDefinitionNode,
  type ListTypeNode,
  type NamedTypeNode,
  type NameNode,
  type OperationTypeDefinitionNode,
  type SchemaDefinitionNode,
  type StringValueNode,
  type TypeDefinitionNode,
  type TypeNode,
} from "graphql";

/**
 * Converts a schema back into an SDL document *including* applied directives,
 * which `printSchema` from graphql-js drops.
 *
 * Definitions are assembled from the live schema objects, reusing each
 * element's AST node verbatim when the schema was built from SDL (so the
 * printed text stays faithful), synthesizing one otherwise. Type extensions
 * are folded into a single definition. On every element, directives from the
 * `extensions.directives` convention code-first libraries use are merged in —
 * both its record form (`{ key: { fields: "id" } }`, arrays for repetition)
 * and its list form (`[{ name: "key", args: { fields: "id" } }]`) — and
 * `@deprecated` / `@specifiedBy` / `@oneOf` are synthesized from the
 * corresponding type properties when no equivalent directive is present yet.
 */
export function getDocumentFromSchema(schema: GraphQLSchema): DocumentNode {
  const definitions: DefinitionNode[] = [];

  const schemaNode = schemaDefinitionNode(schema);

  if (schemaNode !== undefined) {
    definitions.push(schemaNode);
  }

  for (const directive of schema.getDirectives()) {
    if (isSpecifiedDirective(directive)) {
      continue;
    }

    definitions.push(directiveDefinitionNode(directive, schema));
  }

  for (const type of Object.values(schema.getTypeMap())) {
    if (isIntrospectionType(type) || isSpecifiedScalarType(type)) {
      continue;
    }

    definitions.push(typeDefinitionNode(type, schema));
  }

  return { kind: Kind.DOCUMENT, definitions };
}

function schemaDefinitionNode(
  schema: GraphQLSchema,
): SchemaDefinitionNode | undefined {
  const extensionNodes = schema.extensionASTNodes ?? [];

  if (schema.astNode != null || extensionNodes.length > 0) {
    const operationTypes = [
      ...(schema.astNode?.operationTypes ?? []),
      ...extensionNodes.flatMap((node) => node.operationTypes ?? []),
    ];

    return {
      kind: Kind.SCHEMA_DEFINITION,
      description: schema.astNode?.description,
      directives: memberDirectives(
        schema,
        [
          ...(schema.astNode?.directives ?? []),
          ...extensionNodes.flatMap((node) => node.directives ?? []),
        ],
        schema,
        {},
      ),
      operationTypes:
        operationTypes.length > 0
          ? operationTypes
          : defaultOperationTypes(schema),
    };
  }

  // Code-first schema: emit the definition only when it carries information —
  // a description, applied directives, or non-default root type names.
  const operationTypes = defaultOperationTypes(schema);
  const directives = memberDirectives(schema, [], schema, {});
  const hasNonDefaultRootName = operationTypes.some(
    (operationType) =>
      operationType.type.name.value !==
      defaultRootTypeName(operationType.operation),
  );

  if (
    schema.description == null &&
    directives.length === 0 &&
    !hasNonDefaultRootName
  ) {
    return undefined;
  }

  return {
    kind: Kind.SCHEMA_DEFINITION,
    description: descriptionNode(schema.description),
    directives,
    operationTypes,
  };
}

function defaultRootTypeName(operation: OperationTypeNode): string {
  return operation.charAt(0).toUpperCase() + operation.slice(1);
}

function defaultOperationTypes(
  schema: GraphQLSchema,
): OperationTypeDefinitionNode[] {
  const rootTypes = [
    { operation: OperationTypeNode.QUERY, type: schema.getQueryType() },
    { operation: OperationTypeNode.MUTATION, type: schema.getMutationType() },
    {
      operation: OperationTypeNode.SUBSCRIPTION,
      type: schema.getSubscriptionType(),
    },
  ];

  return rootTypes.flatMap(
    ({ operation, type }): OperationTypeDefinitionNode[] =>
      type == null
        ? []
        : [
            {
              kind: Kind.OPERATION_TYPE_DEFINITION,
              operation,
              type: namedTypeNode(type.name),
            },
          ],
  );
}

// ─── Type definitions ────────────────────────────────────────────────────────

function typeDefinitionNode(
  type: GraphQLNamedType,
  schema: GraphQLSchema,
): TypeDefinitionNode {
  // Directives applied in SDL live on the definition node and any extension
  // nodes; members (fields, values) are taken from the live type, which
  // already folds extensions in, so extensions collapse into one definition.
  const astDirectives = [
    ...(type.astNode?.directives ?? []),
    ...(type.extensionASTNodes ?? []).flatMap((node) => node.directives ?? []),
  ];
  const shared = {
    description: type.astNode?.description ?? descriptionNode(type.description),
    name: nameNode(type.name),
  };

  if (isObjectType(type) || isInterfaceType(type)) {
    return {
      kind: isObjectType(type)
        ? Kind.OBJECT_TYPE_DEFINITION
        : Kind.INTERFACE_TYPE_DEFINITION,
      ...shared,
      directives: memberDirectives(type, astDirectives, schema, {}),
      interfaces: type
        .getInterfaces()
        .map((iface) => namedTypeNode(iface.name)),
      fields: Object.values(type.getFields()).map((field) =>
        fieldDefinitionNode(field, schema),
      ),
    };
  }

  if (isUnionType(type)) {
    return {
      kind: Kind.UNION_TYPE_DEFINITION,
      ...shared,
      directives: memberDirectives(type, astDirectives, schema, {}),
      types: type.getTypes().map((member) => namedTypeNode(member.name)),
    };
  }

  if (isEnumType(type)) {
    return {
      kind: Kind.ENUM_TYPE_DEFINITION,
      ...shared,
      directives: memberDirectives(type, astDirectives, schema, {}),
      values: type
        .getValues()
        .map((value) => enumValueDefinitionNode(value, schema)),
    };
  }

  if (isInputObjectType(type)) {
    return {
      kind: Kind.INPUT_OBJECT_TYPE_DEFINITION,
      ...shared,
      directives: memberDirectives(type, astDirectives, schema, {
        isOneOf: type.isOneOf,
      }),
      fields: Object.values(type.getFields()).map((field) =>
        inputValueDefinitionNode(field, schema),
      ),
    };
  }

  // Scalar.
  return {
    kind: Kind.SCALAR_TYPE_DEFINITION,
    ...shared,
    directives: memberDirectives(type, astDirectives, schema, {
      specifiedByURL: type.specifiedByURL,
    }),
  };
}

function fieldDefinitionNode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- source/context types are irrelevant to the AST
  field: GraphQLField<any, any>,
  schema: GraphQLSchema,
): FieldDefinitionNode {
  if (field.astNode != null) {
    return {
      ...field.astNode,
      description:
        field.astNode.description ?? descriptionNode(field.description),
      // Rebuilt (not reused) so argument-level extension directives and
      // programmatic deprecations are picked up; each argument's own astNode
      // is still reused inside.
      arguments: field.args.map((arg) => inputValueDefinitionNode(arg, schema)),
      directives: memberDirectives(
        field,
        field.astNode.directives ?? [],
        schema,
        {
          deprecationReason: field.deprecationReason,
        },
      ),
    };
  }

  return {
    kind: Kind.FIELD_DEFINITION,
    description: descriptionNode(field.description),
    name: nameNode(field.name),
    arguments: field.args.map((arg) => inputValueDefinitionNode(arg, schema)),
    type: typeReferenceNode(field.type),
    directives: memberDirectives(field, [], schema, {
      deprecationReason: field.deprecationReason,
    }),
  };
}

function inputValueDefinitionNode(
  input: GraphQLArgument | GraphQLInputField,
  schema: GraphQLSchema | undefined,
): InputValueDefinitionNode {
  if (input.astNode != null) {
    return {
      ...input.astNode,
      description:
        input.astNode.description ?? descriptionNode(input.description),
      directives: memberDirectives(
        input,
        input.astNode.directives ?? [],
        schema,
        {
          deprecationReason: input.deprecationReason,
        },
      ),
    };
  }

  const defaultValue =
    input.defaultValue === undefined
      ? undefined
      : (astFromValue(input.defaultValue, input.type) as ConstValueNode | null);

  return {
    kind: Kind.INPUT_VALUE_DEFINITION,
    description: descriptionNode(input.description),
    name: nameNode(input.name),
    type: typeReferenceNode(input.type),
    defaultValue: defaultValue ?? undefined,
    directives: memberDirectives(input, [], schema, {
      deprecationReason: input.deprecationReason,
    }),
  };
}

function enumValueDefinitionNode(
  value: GraphQLEnumValue,
  schema: GraphQLSchema,
): EnumValueDefinitionNode {
  if (value.astNode != null) {
    return {
      ...value.astNode,
      description:
        value.astNode.description ?? descriptionNode(value.description),
      directives: memberDirectives(
        value,
        value.astNode.directives ?? [],
        schema,
        {
          deprecationReason: value.deprecationReason,
        },
      ),
    };
  }

  return {
    kind: Kind.ENUM_VALUE_DEFINITION,
    description: descriptionNode(value.description),
    name: nameNode(value.name),
    directives: memberDirectives(value, [], schema, {
      deprecationReason: value.deprecationReason,
    }),
  };
}

function directiveDefinitionNode(
  directive: GraphQLDirective,
  schema: GraphQLSchema,
): DirectiveDefinitionNode {
  if (directive.astNode != null) {
    return {
      ...directive.astNode,
      description:
        directive.astNode.description ?? descriptionNode(directive.description),
      arguments: directive.args.map((arg) =>
        inputValueDefinitionNode(arg, schema),
      ),
    };
  }

  return {
    kind: Kind.DIRECTIVE_DEFINITION,
    description: descriptionNode(directive.description),
    name: nameNode(directive.name),
    arguments: directive.args.map((arg) =>
      inputValueDefinitionNode(arg, undefined),
    ),
    repeatable: directive.isRepeatable,
    locations: directive.locations.map((location) => nameNode(location)),
  };
}

// ─── Directive assembly per element ──────────────────────────────────────────

interface DirectiveExtras {
  readonly deprecationReason?: string | null;
  readonly specifiedByURL?: string | null;
  readonly isOneOf?: boolean;
}

/**
 * Assembles the applied directives of one schema element: the AST-sourced
 * directives, plus `extensions.directives` entries not already present
 * (compared by printed form), plus `@deprecated` / `@specifiedBy` / `@oneOf`
 * synthesized from the element's properties when no directive of that name
 * exists yet.
 */
function memberDirectives(
  element: { readonly extensions?: unknown },
  astDirectives: readonly ConstDirectiveNode[],
  schema: GraphQLSchema | undefined,
  extras: DirectiveExtras,
): ConstDirectiveNode[] {
  const directives = [...astDirectives];
  // Snapshots of the AST-sourced directives only: extension entries are
  // deduped against the SDL-applied directives, not against each other, so
  // legitimate identical repetitions of a repeatable directive survive.
  const astPrinted = new Set(directives.map((node) => print(node)));
  const appliedNames = new Set(directives.map((node) => node.name.value));

  for (const node of extensionDirectiveNodes(element, schema)) {
    const name = node.name.value;
    const definition = schema?.getDirective(name);

    if (definition?.isRepeatable === true) {
      if (astPrinted.has(print(node))) {
        continue;
      }
    } else if (appliedNames.has(name)) {
      // Non-repeatable (or unknown) directives allow one application; a
      // spelling difference between the SDL literal and the extension's
      // rendering must not produce invalid duplicated SDL.
      continue;
    }

    appliedNames.add(name);
    directives.push(node);
  }

  const names = new Set(directives.map((node) => node.name.value));

  if (extras.deprecationReason != null && !names.has("deprecated")) {
    directives.push(deprecatedDirectiveNode(extras.deprecationReason));
  }

  if (extras.specifiedByURL != null && !names.has("specifiedBy")) {
    directives.push(
      directiveNode("specifiedBy", {
        url: { kind: Kind.STRING, value: extras.specifiedByURL },
      }),
    );
  }

  if (extras.isOneOf === true && !names.has("oneOf")) {
    directives.push(directiveNode("oneOf", {}));
  }

  return directives;
}

// ─── Applied directives from the `extensions.directives` convention ──────────

interface DirectiveUsage {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

function extensionDirectiveNodes(
  element: { readonly extensions?: unknown },
  schema: GraphQLSchema | undefined,
): ConstDirectiveNode[] {
  const extensions = element.extensions as
    { directives?: unknown } | null | undefined;
  const directives = extensions?.directives;
  const usages: DirectiveUsage[] = [];

  if (Array.isArray(directives)) {
    for (const entry of directives as readonly unknown[]) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string"
      ) {
        usages.push({
          name: (entry as { name: string }).name,
          args: asArgsRecord((entry as { args?: unknown }).args),
        });
      }
    }
  } else if (typeof directives === "object" && directives !== null) {
    for (const [name, args] of Object.entries(
      directives as Record<string, unknown>,
    )) {
      if (Array.isArray(args)) {
        for (const repetition of args as readonly unknown[]) {
          usages.push({ name, args: asArgsRecord(repetition) });
        }
      } else {
        usages.push({ name, args: asArgsRecord(args) });
      }
    }
  }

  return usages.map((usage) => appliedDirectiveNode(usage, schema));
}

function asArgsRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function appliedDirectiveNode(
  usage: DirectiveUsage,
  schema: GraphQLSchema | undefined,
): ConstDirectiveNode {
  const definition = schema?.getDirective(usage.name);
  const args = Object.entries(usage.args).flatMap(
    ([argName, value]): ConstArgumentNode[] => {
      if (value === undefined) {
        return [];
      }

      const argDef = definition?.args.find((arg) => arg.name === argName);
      let valueNode: ConstValueNode | null | undefined;

      if (argDef !== undefined) {
        try {
          valueNode = astFromValue(value, argDef.type) as ConstValueNode | null;
        } catch {
          valueNode = undefined;
        }
      }

      // Enum-typed arguments given by value name don't survive astFromValue
      // (it maps internal values), so recognize the name directly.
      valueNode ??= enumNameValueNode(argDef?.type, value);
      valueNode ??= untypedValueNode(value);

      return valueNode === undefined
        ? []
        : [{ kind: Kind.ARGUMENT, name: nameNode(argName), value: valueNode }];
    },
  );

  return {
    kind: Kind.DIRECTIVE,
    name: nameNode(usage.name),
    arguments: args,
  };
}

function enumNameValueNode(
  type: GraphQLInputType | undefined,
  value: unknown,
): ConstValueNode | undefined {
  if (type === undefined) {
    return undefined;
  }

  if (isNonNullType(type)) {
    return enumNameValueNode(type.ofType, value);
  }

  if (isListType(type) && Array.isArray(value)) {
    const values: ConstValueNode[] = [];

    for (const item of value as readonly unknown[]) {
      const node =
        enumNameValueNode(type.ofType, item) ?? untypedValueNode(item);

      if (node === undefined) {
        return undefined;
      }

      values.push(node);
    }

    return { kind: Kind.LIST, values };
  }

  if (
    isEnumType(type) &&
    typeof value === "string" &&
    type.getValue(value) != null
  ) {
    return { kind: Kind.ENUM, value };
  }

  return undefined;
}

function untypedValueNode(value: unknown): ConstValueNode | undefined {
  if (value === null) {
    return { kind: Kind.NULL };
  }

  switch (typeof value) {
    case "boolean":
      return { kind: Kind.BOOLEAN, value };
    case "string":
      return { kind: Kind.STRING, value };
    case "number":
      if (!Number.isFinite(value)) {
        return undefined;
      }

      return Number.isInteger(value)
        ? { kind: Kind.INT, value: String(value) }
        : { kind: Kind.FLOAT, value: String(value) };

    case "object": {
      if (Array.isArray(value)) {
        return {
          kind: Kind.LIST,
          values: (value as readonly unknown[]).flatMap((item) => {
            const node = untypedValueNode(item);

            return node === undefined ? [] : [node];
          }),
        };
      }

      return {
        kind: Kind.OBJECT,
        fields: Object.entries(value as Record<string, unknown>).flatMap(
          ([fieldName, fieldValue]): ConstObjectFieldNode[] => {
            const node = untypedValueNode(fieldValue);

            return node === undefined
              ? []
              : [
                  {
                    kind: Kind.OBJECT_FIELD,
                    name: nameNode(fieldName),
                    value: node,
                  },
                ];
          },
        ),
      };
    }

    default:
      return undefined;
  }
}

// ─── Shared node helpers ─────────────────────────────────────────────────────

function deprecatedDirectiveNode(reason: string): ConstDirectiveNode {
  return directiveNode(
    "deprecated",
    // The constant is used instead of reading the directive's own arg default:
    // graphql@17 moved argument defaults from `defaultValue` to `default`.
    reason === DEFAULT_DEPRECATION_REASON
      ? {}
      : { reason: { kind: Kind.STRING, value: reason } },
  );
}

function directiveNode(
  name: string,
  args: Record<string, ConstValueNode>,
): ConstDirectiveNode {
  return {
    kind: Kind.DIRECTIVE,
    name: nameNode(name),
    arguments: Object.entries(args).map(
      ([argName, value]): ConstArgumentNode => ({
        kind: Kind.ARGUMENT,
        name: nameNode(argName),
        value,
      }),
    ),
  };
}

function typeReferenceNode(type: GraphQLType): TypeNode {
  if (isListType(type)) {
    return { kind: Kind.LIST_TYPE, type: typeReferenceNode(type.ofType) };
  }

  if (isNonNullType(type)) {
    return {
      kind: Kind.NON_NULL_TYPE,
      type: typeReferenceNode(type.ofType) as NamedTypeNode | ListTypeNode,
    };
  }

  return namedTypeNode(type.name);
}

function namedTypeNode(name: string): NamedTypeNode {
  return { kind: Kind.NAMED_TYPE, name: nameNode(name) };
}

function nameNode(value: string): NameNode {
  return { kind: Kind.NAME, value };
}

function descriptionNode(
  description: string | null | undefined,
): StringValueNode | undefined {
  return description == null
    ? undefined
    : { kind: Kind.STRING, value: description, block: true };
}
