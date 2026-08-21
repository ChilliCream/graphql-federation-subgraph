import {
  buildASTSchema,
  parse,
  type DocumentNode,
  type GraphQLDirective,
  type GraphQLScalarType,
} from "graphql";

/**
 * The SDL of every directive and scalar defined by the GraphQL Composite
 * Schemas Spec for source schemas, verbatim from the spec:
 * https://github.com/graphql/composite-schemas-spec
 *
 * `@interfaceObject` and `@implement` are provisional — they come from the
 * open spec PR https://github.com/graphql/composite-schemas-spec/pull/233 and
 * may still change before that PR is merged.
 */
// eslint-disable-next-line @typescript-eslint/no-inferrable-types -- keeps the emitted declaration `string` instead of the full SDL literal type
export const federationTypeDefsSDL: string = /* GraphQL */ `
  scalar FieldSelectionMap

  scalar FieldSelectionSet

  directive @lookup on FIELD_DEFINITION

  directive @internal on OBJECT | FIELD_DEFINITION

  directive @inaccessible on
    | FIELD_DEFINITION
    | OBJECT
    | INTERFACE
    | UNION
    | ARGUMENT_DEFINITION
    | SCALAR
    | ENUM
    | ENUM_VALUE
    | INPUT_OBJECT
    | INPUT_FIELD_DEFINITION

  directive @is(field: FieldSelectionMap!) on ARGUMENT_DEFINITION

  directive @require(field: FieldSelectionMap!) on ARGUMENT_DEFINITION

  directive @key(fields: FieldSelectionSet!) repeatable on OBJECT | INTERFACE

  directive @shareable repeatable on OBJECT | FIELD_DEFINITION

  directive @provides(fields: FieldSelectionSet!) on FIELD_DEFINITION

  directive @external on FIELD_DEFINITION

  directive @override(from: String!) on FIELD_DEFINITION

  directive @interfaceObject on OBJECT

  directive @implement on FIELD_DEFINITION
`;

/**
 * {@link federationTypeDefsSDL} as a parsed document — handy for servers and
 * tools that take an array of type definitions, e.g.
 * `makeExecutableSchema({ typeDefs: [federationTypeDefs, myTypeDefs] })`.
 */
export const federationTypeDefs: DocumentNode = parse(federationTypeDefsSDL);

/**
 * The names of all federation directives this package defines, including the
 * provisional `interfaceObject` and `implement` from spec PR #233.
 */
export const federationDirectiveNames: readonly string[] = [
  "lookup",
  "internal",
  "inaccessible",
  "is",
  "require",
  "key",
  "shareable",
  "provides",
  "external",
  "override",
  "interfaceObject",
  "implement",
];

/**
 * The names of the scalars the federation directives depend on.
 */
export const federationScalarNames: readonly string[] = [
  "FieldSelectionMap",
  "FieldSelectionSet",
];

const definitionsSchema = buildASTSchema(federationTypeDefs);

function getDirective(name: string): GraphQLDirective {
  const directive = definitionsSchema.getDirective(name);

  if (!directive) {
    throw new Error(`Missing federation directive definition: @${name}`);
  }

  return directive;
}

function getScalar(name: string): GraphQLScalarType {
  const type = definitionsSchema.getType(name);

  if (!type) {
    throw new Error(`Missing federation scalar definition: ${name}`);
  }

  return type as GraphQLScalarType;
}

/** Marks a field as an entity lookup the distributed executor may use. */
export const lookupDirective: GraphQLDirective = getDirective("lookup");
/** Declares types/fields that are local to this source schema and hidden from the composite schema. */
export const internalDirective: GraphQLDirective = getDirective("internal");
/** Hides a schema member from the client-facing composite schema, globally. */
export const inaccessibleDirective: GraphQLDirective =
  getDirective("inaccessible");
/** Maps a lookup argument to a field of the entity the lookup resolves. */
export const isDirective: GraphQLDirective = getDirective("is");
/** Declares an argument whose value the executor resolves from other source schemas. */
export const requireDirective: GraphQLDirective = getDirective("require");
/** Designates a stable key that identifies an entity across source schemas. */
export const keyDirective: GraphQLDirective = getDirective("key");
/** Allows a field (or all fields of a type) to be contributed by multiple source schemas. */
export const shareableDirective: GraphQLDirective = getDirective("shareable");
/** Declares subfields of the return type this field can resolve locally. */
export const providesDirective: GraphQLDirective = getDirective("provides");
/** Marks a field this source schema recognizes but does not resolve itself. */
export const externalDirective: GraphQLDirective = getDirective("external");
/** Migrates a field from another source schema to this one. */
export const overrideDirective: GraphQLDirective = getDirective("override");
/**
 * Marks an object type as a stand-in for an interface defined in another
 * source schema. Provisional — from spec PR #233, may change before merge.
 */
export const interfaceObjectDirective: GraphQLDirective =
  getDirective("interfaceObject");
/**
 * Marks a field as an explicit replacement for an implementation projected
 * from an `@interfaceObject` stand-in. Provisional — from spec PR #233, may
 * change before merge.
 */
export const implementDirective: GraphQLDirective = getDirective("implement");

/**
 * All federation directives as `GraphQLDirective` instances, for code-first
 * schemas, e.g.
 * `new GraphQLSchema({ ..., directives: [...specifiedDirectives, ...federationDirectives] })`.
 */
export const federationDirectives: readonly GraphQLDirective[] = [
  lookupDirective,
  internalDirective,
  inaccessibleDirective,
  isDirective,
  requireDirective,
  keyDirective,
  shareableDirective,
  providesDirective,
  externalDirective,
  overrideDirective,
  interfaceObjectDirective,
  implementDirective,
];

/** The `FieldSelectionMap` scalar used by `@is` and `@require`. */
export const fieldSelectionMapScalar: GraphQLScalarType =
  getScalar("FieldSelectionMap");
/** The `FieldSelectionSet` scalar used by `@key` and `@provides`. */
export const fieldSelectionSetScalar: GraphQLScalarType =
  getScalar("FieldSelectionSet");
