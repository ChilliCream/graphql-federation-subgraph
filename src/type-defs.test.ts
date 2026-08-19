import { describe, expect, it } from "vitest";
import { DirectiveLocation, Kind, GraphQLNonNull } from "graphql";
import {
  federationDirectiveNames,
  federationDirectives,
  federationScalarNames,
  federationTypeDefs,
  fieldSelectionMapScalar,
  fieldSelectionSetScalar,
  implementDirective,
  inaccessibleDirective,
  interfaceObjectDirective,
  keyDirective,
  overrideDirective,
  shareableDirective
} from "./index.js";

describe("federation type definitions", () => {
  it("defines every directive and scalar exactly once", () => {
    const directiveDefs = federationTypeDefs.definitions.filter(
      (d) => d.kind === Kind.DIRECTIVE_DEFINITION
    );
    const scalarDefs = federationTypeDefs.definitions.filter(
      (d) => d.kind === Kind.SCALAR_TYPE_DEFINITION
    );

    expect(directiveDefs.map((d) => d.name.value).sort()).toEqual(
      [...federationDirectiveNames].sort()
    );
    expect(scalarDefs.map((d) => d.name.value).sort()).toEqual(
      [...federationScalarNames].sort()
    );
    expect(federationDirectives.map((d) => d.name).sort()).toEqual(
      [...federationDirectiveNames].sort()
    );
  });

  it("matches the spec definition of @key", () => {
    expect(keyDirective.isRepeatable).toBe(true);
    expect(keyDirective.locations).toEqual([
      DirectiveLocation.OBJECT,
      DirectiveLocation.INTERFACE
    ]);
    const fields = keyDirective.args.find((arg) => arg.name === "fields");
    expect(fields).toBeDefined();
    expect(fields!.type).toBeInstanceOf(GraphQLNonNull);
    expect(String(fields!.type)).toBe("FieldSelectionSet!");
  });

  it("matches the spec definition of @override", () => {
    expect(overrideDirective.isRepeatable).toBe(false);
    expect(overrideDirective.locations).toEqual([
      DirectiveLocation.FIELD_DEFINITION
    ]);
    const from = overrideDirective.args.find((arg) => arg.name === "from");
    expect(String(from!.type)).toBe("String!");
    expect(from!.defaultValue).toBeUndefined();
  });

  it("matches the spec definition of @shareable and @inaccessible", () => {
    expect(shareableDirective.isRepeatable).toBe(true);
    expect(shareableDirective.locations).toEqual([
      DirectiveLocation.OBJECT,
      DirectiveLocation.FIELD_DEFINITION
    ]);
    expect(inaccessibleDirective.locations).toHaveLength(10);
  });

  it("matches PR #233 definitions of @interfaceObject and @implement", () => {
    expect(interfaceObjectDirective.locations).toEqual([
      DirectiveLocation.OBJECT
    ]);
    expect(interfaceObjectDirective.args).toEqual([]);
    expect(interfaceObjectDirective.isRepeatable).toBe(false);

    expect(implementDirective.locations).toEqual([
      DirectiveLocation.FIELD_DEFINITION
    ]);
    expect(implementDirective.args).toEqual([]);
    expect(implementDirective.isRepeatable).toBe(false);
  });

  it("exposes the spec scalars", () => {
    expect(fieldSelectionMapScalar.name).toBe("FieldSelectionMap");
    expect(fieldSelectionSetScalar.name).toBe("FieldSelectionSet");
  });
});
