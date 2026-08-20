import {
  GraphQLDirective,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLUnionType,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isSpecifiedDirective,
  isSpecifiedScalarType,
  isUnionType,
  valueFromAST,
  valueFromASTUntyped,
  type ConstValueNode,
  type GraphQLArgumentConfig,
  type GraphQLEnumValueConfig,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLFieldResolver,
  type GraphQLInputFieldConfig,
  type GraphQLInputType,
  type GraphQLIsTypeOfFn,
  type GraphQLNamedType,
  type GraphQLNullableType,
  type GraphQLOutputType,
  type GraphQLScalarLiteralParser,
  type GraphQLScalarSerializer,
  type GraphQLScalarType,
  type GraphQLScalarValueParser,
  type GraphQLType,
  type GraphQLTypeResolver,
} from "graphql";

/* eslint-disable @typescript-eslint/no-explicit-any -- resolver maps mirror the
   `any`-based signatures of graphql-js resolvers; stricter parameters would
   reject perfectly valid resolver functions under strictFunctionTypes */

/**
 * A field entry in a {@link SubgraphTypeResolvers} map: either the resolver
 * function itself or an object carrying `resolve` and/or `subscribe`.
 */
export interface SubgraphFieldResolverConfig<TContext = any> {
  readonly resolve?: GraphQLFieldResolver<any, TContext>;
  readonly subscribe?: GraphQLFieldResolver<any, TContext>;
}

/**
 * Resolvers for one object, interface, or union type. Keys are field names,
 * plus the special `__resolveType` (interfaces and unions) and `__isTypeOf`
 * (object types) entries.
 */
export type SubgraphTypeResolvers<TContext = any> = Record<
  string,
  | GraphQLFieldResolver<any, TContext>
  | SubgraphFieldResolverConfig<TContext>
  | GraphQLTypeResolver<any, TContext>
  | GraphQLIsTypeOfFn<any, TContext>
>;

/**
 * Parsing/serialization functions for a custom scalar, applied to the scalar
 * instance the schema defines. A full `GraphQLScalarType` is also accepted in
 * its place.
 */
export interface SubgraphScalarResolverConfig {
  readonly serialize?: GraphQLScalarSerializer<any>;
  readonly parseValue?: GraphQLScalarValueParser<any>;
  readonly parseLiteral?: GraphQLScalarLiteralParser<any>;
}

/**
 * Internal values for an enum type, keyed by the enum value names from the
 * SDL, e.g. `{ RED: "#ff0000" }`.
 */
export type SubgraphEnumValues = Record<string, unknown>;

/**
 * The resolver map accepted by `buildSubgraphSchema`: type names mapped to
 * field resolvers, scalar configs, or enum internal values.
 */
export type SubgraphResolvers<TContext = any> = Record<
  string,
  | SubgraphTypeResolvers<TContext>
  | SubgraphScalarResolverConfig
  | GraphQLScalarType
  | SubgraphEnumValues
>;

type AnyFieldResolver = GraphQLFieldResolver<any, any>;
type AnyTypeResolver = GraphQLTypeResolver<any, any>;
type AnyIsTypeOfFn = GraphQLIsTypeOfFn<any, any>;

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Wires resolver maps into a schema built from SDL: field resolvers,
 * `__resolveType`/`__isTypeOf`, scalar parsing functions, and enum internal
 * values. Returns the same schema instance unless enum internal values are
 * mapped, in which case the affected enum types (and everything referencing
 * them) are rebuilt.
 */
export function attachResolvers<TContext>(
  schema: GraphQLSchema,
  resolverMaps: readonly SubgraphResolvers<TContext>[],
): GraphQLSchema {
  const enumValueMaps = new Map<string, SubgraphEnumValues>();
  const explicitParseLiteral = new WeakSet<GraphQLScalarType>();
  let scalarInputCoercionChanged = false;

  for (const resolvers of resolverMaps) {
    for (const [typeName, entry] of Object.entries(resolvers)) {
      const type = schema.getType(typeName);

      if (type === undefined) {
        throw new Error(
          `buildSubgraphSchema: resolvers reference the type "${typeName}", which the schema does not define.`,
        );
      }

      if (isIntrospectionType(type)) {
        throw new Error(
          `buildSubgraphSchema: resolvers must not target the introspection type "${typeName}".`,
        );
      }

      if (isScalarType(type)) {
        scalarInputCoercionChanged =
          attachScalarResolver(type, entry, typeName, explicitParseLiteral) ||
          scalarInputCoercionChanged;
      } else if (isEnumType(type)) {
        collectEnumValues(type, entry, typeName, enumValueMaps);
      } else if (isUnionType(type)) {
        attachUnionResolvers(type, entry, typeName);
      } else if (isObjectType(type) || isInterfaceType(type)) {
        attachFieldResolvers(type, entry, typeName);
      } else {
        throw new Error(
          `buildSubgraphSchema: resolvers reference "${typeName}", but input object types cannot have resolvers.`,
        );
      }
    }
  }

  if (scalarInputCoercionChanged) {
    recoerceDefaultValues(schema);
  }

  return enumValueMaps.size > 0
    ? replaceEnumValues(schema, enumValueMaps)
    : schema;
}

/**
 * Applies a scalar resolver entry by mutating the scalar instance the schema
 * defines. Returns whether input coercion (parseValue/parseLiteral) changed,
 * so callers know to re-coerce SDL default values.
 */
function attachScalarResolver(
  type: GraphQLScalarType,
  entry: SubgraphResolvers[string],
  typeName: string,
  explicitParseLiteral: WeakSet<GraphQLScalarType>,
): boolean {
  if (isSpecifiedScalarType(type)) {
    throw new Error(
      `buildSubgraphSchema: the built-in scalar "${typeName}" cannot be overridden with resolvers.`,
    );
  }

  let config: SubgraphScalarResolverConfig;

  if (isScalarType(entry)) {
    config = {
      serialize: entry.serialize,
      parseValue: entry.parseValue,
      parseLiteral: entry.parseLiteral,
    };

    if (entry.description != null) {
      type.description = entry.description;
    }

    if (entry.specifiedByURL != null) {
      type.specifiedByURL = entry.specifiedByURL;
    }

    if (Object.keys(entry.extensions).length > 0) {
      type.extensions = entry.extensions;
    }
  } else {
    config = entry as SubgraphScalarResolverConfig;
  }

  let parseLiteral = config.parseLiteral;

  if (parseLiteral !== undefined) {
    explicitParseLiteral.add(type);
  } else if (
    config.parseValue !== undefined &&
    !explicitParseLiteral.has(type)
  ) {
    // graphql-js derives the default parseLiteral from parseValue only at
    // construction time, so overriding parseValue alone would leave inline
    // literals coerced by the scalar's original identity function. A
    // parseLiteral explicitly attached by an earlier resolver map is kept.
    const parseValue = config.parseValue;
    parseLiteral = (node, variables): unknown =>
      parseValue(valueFromASTUntyped(node, variables ?? undefined));
  }

  if (config.serialize) {
    setScalarFunction(type, "serialize", "coerceOutputValue", config.serialize);
  }

  if (config.parseValue) {
    setScalarFunction(
      type,
      "parseValue",
      "coerceInputValue",
      config.parseValue,
    );
  }

  if (parseLiteral) {
    setScalarFunction(type, "parseLiteral", "coerceInputLiteral", parseLiteral);
  }

  return config.parseValue !== undefined || parseLiteral !== undefined;
}

// graphql-js 17 executes scalars through coerceOutputValue / coerceInputValue /
// coerceInputLiteral, which are defaulted from the legacy function names only
// at construction time — mirror every assignment onto the v17 method when the
// running graphql version has it, or the resolver would silently not be used.
function setScalarFunction(
  type: GraphQLScalarType,
  legacyName: "serialize" | "parseValue" | "parseLiteral",
  v17Name: string,
  fn: unknown,
): void {
  const target = type as unknown as Record<string, unknown>;
  target[legacyName] = fn;

  if (v17Name in target) {
    target[v17Name] = fn;
  }
}

/**
 * Re-coerces argument and input-field default values from their SDL AST.
 * graphql-js computes them while the schema is built — before resolvers are
 * attached — so a default touching a custom scalar would otherwise keep the
 * identity-coerced raw literal. When the user's parser rejects the literal,
 * the previously stored value is kept rather than dropping the default.
 */
function recoerceDefaultValues(schema: GraphQLSchema): void {
  const recoerce = (input: {
    readonly type: GraphQLInputType;
    astNode?: { readonly defaultValue?: unknown } | null;
    defaultValue?: unknown;
  }): void => {
    const defaultValueNode = (
      input.astNode as { defaultValue?: ConstValueNode } | null | undefined
    )?.defaultValue;

    if (defaultValueNode == null) {
      return;
    }

    const value = valueFromAST(defaultValueNode, input.type);

    if (value !== undefined) {
      input.defaultValue = value;
    }
  };

  // valueFromAST fills omitted input-object fields from the referenced
  // type's CURRENT field defaults, so input object types are finalized in
  // dependency order before anything that may embed their defaults — a
  // default like `f: Filter = {}` must see Filter's re-coerced fields.
  const finalized = new Set<string>();

  const finalizeInputObject = (type: GraphQLInputObjectType): void => {
    if (finalized.has(type.name)) {
      return;
    }

    finalized.add(type.name);

    for (const field of Object.values(type.getFields())) {
      const named = getNamedType(field.type);

      if (isInputObjectType(named)) {
        finalizeInputObject(named);
      }

      recoerce(field);
    }
  };

  for (const type of Object.values(schema.getTypeMap())) {
    if (!isIntrospectionType(type) && isInputObjectType(type)) {
      finalizeInputObject(type);
    }
  }

  for (const type of Object.values(schema.getTypeMap())) {
    if (isIntrospectionType(type)) {
      continue;
    }

    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        for (const arg of field.args) {
          recoerce(arg);
        }
      }
    }
  }

  for (const directive of schema.getDirectives()) {
    for (const arg of directive.args) {
      recoerce(arg);
    }
  }
}

function collectEnumValues(
  type: GraphQLEnumType,
  entry: SubgraphResolvers[string],
  typeName: string,
  enumValueMaps: Map<string, SubgraphEnumValues>,
): void {
  const values = entry as SubgraphEnumValues;
  const defined = new Set(type.getValues().map((value) => value.name));

  for (const valueName of Object.keys(values)) {
    if (!defined.has(valueName)) {
      throw new Error(
        `buildSubgraphSchema: resolvers reference the enum value "${typeName}.${valueName}", which the schema does not define.`,
      );
    }
  }

  // Null-prototype so enum values named after Object.prototype members
  // (toString, constructor, …) can never pick up inherited functions.
  enumValueMaps.set(
    typeName,
    Object.assign(
      Object.create(null) as SubgraphEnumValues,
      enumValueMaps.get(typeName),
      values,
    ),
  );
}

function attachUnionResolvers(
  type: GraphQLUnionType,
  entry: SubgraphResolvers[string],
  typeName: string,
): void {
  for (const [key, value] of Object.entries(entry)) {
    if (key === "__resolveType") {
      type.resolveType = expectFunction(
        value,
        typeName,
        key,
      ) as AnyTypeResolver;
      continue;
    }

    if (key.startsWith("__")) {
      throw unsupportedSpecialResolverError(typeName, key);
    }

    throw new Error(
      `buildSubgraphSchema: "${typeName}" is a union type; only "__resolveType" is a valid resolver entry (got "${key}").`,
    );
  }
}

function attachFieldResolvers(
  type: GraphQLObjectType | GraphQLInterfaceType,
  entry: SubgraphResolvers[string],
  typeName: string,
): void {
  const fields = type.getFields();

  for (const [key, value] of Object.entries(entry)) {
    if (key.startsWith("__")) {
      if (key === "__resolveType") {
        if (isObjectType(type)) {
          throw new Error(
            `buildSubgraphSchema: "__resolveType" is only valid on interface and union types ("${typeName}" is an object type; use "__isTypeOf" on its members instead).`,
          );
        }

        type.resolveType = expectFunction(
          value,
          typeName,
          key,
        ) as AnyTypeResolver;
      } else if (key === "__isTypeOf") {
        if (isInterfaceType(type)) {
          throw new Error(
            `buildSubgraphSchema: "__isTypeOf" is only valid on object types ("${typeName}" is an interface; use "__resolveType" instead).`,
          );
        }

        type.isTypeOf = expectFunction(value, typeName, key) as AnyIsTypeOfFn;
      } else {
        throw unsupportedSpecialResolverError(typeName, key);
      }

      continue;
    }

    const field = fields[key];

    if (field === undefined) {
      throw new Error(
        `buildSubgraphSchema: resolvers reference the field "${typeName}.${key}", which the schema does not define.`,
      );
    }

    if (typeof value === "function") {
      // Bound to the per-type resolver object so method-style resolvers can
      // reach sibling helpers via `this`, matching makeExecutableSchema.
      field.resolve = (value as AnyFieldResolver).bind(entry);
      continue;
    }

    if (typeof value === "object" && value !== null) {
      const config = value as SubgraphFieldResolverConfig;

      if (config.resolve === undefined && config.subscribe === undefined) {
        throw new Error(
          `buildSubgraphSchema: the resolver for "${typeName}.${key}" must be a function or an object with "resolve" and/or "subscribe".`,
        );
      }

      if (config.resolve !== undefined) {
        field.resolve = config.resolve;
      }

      if (config.subscribe !== undefined) {
        field.subscribe = config.subscribe;
      }

      continue;
    }

    throw new Error(
      `buildSubgraphSchema: the resolver for "${typeName}.${key}" must be a function or an object with "resolve" and/or "subscribe".`,
    );
  }
}

// This package implements the GraphQL Federation Spec, which resolves
// entities through ordinary @lookup fields — Apollo Federation's reference
// resolvers have no role here, and pretending to accept them would leave
// migrated resolver maps silently broken.
function unsupportedSpecialResolverError(typeName: string, key: string): Error {
  if (key === "__resolveReference") {
    return new Error(
      `buildSubgraphSchema: "${typeName}.__resolveReference" is an Apollo Federation reference resolver, which the GraphQL Federation Spec does not use — entities are resolved through ordinary @lookup fields with ordinary resolvers. Remove it and expose a @lookup field instead.`,
    );
  }

  return new Error(
    `buildSubgraphSchema: "${typeName}.${key}" is not a supported resolver entry ("__resolveType" and "__isTypeOf" are the only special entries).`,
  );
}

function expectFunction(
  value: unknown,
  typeName: string,
  key: string,
): (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(
      `buildSubgraphSchema: "${typeName}.${key}" must be a function.`,
    );
  }

  return value as (...args: never[]) => unknown;
}

/**
 * Rebuilds the schema with the given enum types carrying mapped internal
 * values. `GraphQLEnumType` caches its value lookup at construction, so the
 * values cannot be changed in place; instead the enums — and every type or
 * directive that could reference them — are reconstructed, using only public
 * graphql-js API. Argument and input-field default values are re-coerced from
 * their SDL AST so enum defaults map to the new internal values as well.
 */
function replaceEnumValues(
  schema: GraphQLSchema,
  enumValueMaps: ReadonlyMap<string, SubgraphEnumValues>,
): GraphQLSchema {
  const replacements = new Map<string, GraphQLNamedType>();

  const replaceNamedType = <T extends GraphQLNamedType>(type: T): T => {
    if (isIntrospectionType(type) || isSpecifiedScalarType(type)) {
      return type;
    }

    const existing = replacements.get(type.name);

    if (existing !== undefined) {
      return existing as T;
    }

    // Cycles are safe: the rebuilt type is cached before any of its thunks
    // (fields, interfaces, union members) can run.
    const rebuilt = rebuildNamedType(type);
    replacements.set(type.name, rebuilt);

    return rebuilt as T;
  };

  const replaceType = (type: GraphQLType): GraphQLType => {
    if (isListType(type)) {
      return new GraphQLList(replaceType(type.ofType));
    }

    if (isNonNullType(type)) {
      return new GraphQLNonNull(
        replaceType(type.ofType) as GraphQLNullableType,
      );
    }

    return replaceNamedType(type);
  };

  const replaceInputValueConfig = <
    T extends GraphQLArgumentConfig | GraphQLInputFieldConfig,
  >(
    config: T,
  ): T => {
    const type = replaceType(config.type) as GraphQLInputType;
    const defaultValueNode = config.astNode?.defaultValue;
    let defaultValue = config.defaultValue;

    if (defaultValueNode != null) {
      // Falls back to the previously stored value when the AST literal does
      // not coerce (e.g. a user parser that rejects it) instead of silently
      // dropping the default. Only strict undefined signals failure — null is
      // a legitimate internal value.
      const recoerced = valueFromAST(defaultValueNode, type);

      if (recoerced !== undefined) {
        defaultValue = recoerced;
      }
    }

    return { ...config, type, defaultValue };
  };

  const replaceArgs = (
    args: GraphQLFieldConfigArgumentMap,
  ): GraphQLFieldConfigArgumentMap => mapValues(args, replaceInputValueConfig);

  const replaceFields = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the GraphQLObjectType.toConfig() signature
    fields: GraphQLFieldConfigMap<any, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the GraphQLObjectType.toConfig() signature
  ): GraphQLFieldConfigMap<any, any> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the GraphQLObjectType.toConfig() signature
    mapValues(fields, (field: GraphQLFieldConfig<any, any>) => ({
      ...field,
      type: replaceType(field.type) as GraphQLOutputType,
      args: field.args === undefined ? undefined : replaceArgs(field.args),
    }));

  function rebuildNamedType(type: GraphQLNamedType): GraphQLNamedType {
    if (isObjectType(type)) {
      const config = type.toConfig();

      return new GraphQLObjectType({
        ...config,
        interfaces: () => config.interfaces.map(replaceNamedType),
        fields: () => replaceFields(config.fields),
      });
    }

    if (isInterfaceType(type)) {
      const config = type.toConfig();

      return new GraphQLInterfaceType({
        ...config,
        interfaces: () => config.interfaces.map(replaceNamedType),
        fields: () => replaceFields(config.fields),
      });
    }

    if (isUnionType(type)) {
      const config = type.toConfig();

      return new GraphQLUnionType({
        ...config,
        types: () => config.types.map(replaceNamedType),
      });
    }

    if (isEnumType(type)) {
      const config = type.toConfig();
      const valueMap = enumValueMaps.get(type.name);

      if (valueMap === undefined) {
        return type;
      }

      return new GraphQLEnumType({
        ...config,
        values: mapValues(
          config.values,
          (value: GraphQLEnumValueConfig, name) =>
            Object.hasOwn(valueMap, name)
              ? { ...value, value: valueMap[name] }
              : value,
        ),
      });
    }

    if (isInputObjectType(type)) {
      const config = type.toConfig();

      return new GraphQLInputObjectType({
        ...config,
        fields: () => mapValues(config.fields, replaceInputValueConfig),
      });
    }

    // Scalars reference no other types and keep their (possibly mutated)
    // instance.
    return type;
  }

  const replaceDirective = (directive: GraphQLDirective): GraphQLDirective => {
    if (isSpecifiedDirective(directive)) {
      return directive;
    }

    const config = directive.toConfig();

    return new GraphQLDirective({ ...config, args: replaceArgs(config.args) });
  };

  const config = schema.toConfig();

  return new GraphQLSchema({
    ...config,
    query: config.query == null ? config.query : replaceNamedType(config.query),
    mutation:
      config.mutation == null
        ? config.mutation
        : replaceNamedType(config.mutation),
    subscription:
      config.subscription == null
        ? config.subscription
        : replaceNamedType(config.subscription),
    types: config.types.map(replaceNamedType),
    directives: config.directives.map(replaceDirective),
  });
}

function mapValues<T, U>(
  object: Readonly<Record<string, T>>,
  fn: (value: T, key: string) => U,
): Record<string, U> {
  const result: Record<string, U> = Object.create(null) as Record<string, U>;

  for (const [key, value] of Object.entries(object)) {
    result[key] = fn(value, key);
  }

  return result;
}
