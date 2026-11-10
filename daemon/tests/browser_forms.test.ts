import { describe, expect, test } from "bun:test";

import type { OperationDescriptor } from "../src/protocol/OperationDescriptor.ts";
import { acceptsKind, actionControl, controlFor, initialValue, type Control } from "../src/browser/forms.ts";

function operation(input: unknown, fields: string[]): OperationDescriptor {
  return {
    name: "rename_thread", label: "Rename thread", category: "conversation", scope: "character", prerequisites: [], effects: [],
    confirmation: "none", fields: Object.fromEntries(fields.map((field) => [field, { label: field }])), input, output: true,
  } as unknown as OperationDescriptor;
}

describe("a schema becomes the control that edits it", () => {
  test("anything goes for an empty or true schema, and nothing but a schema object is a schema", () => {
    expect(controlFor(true)).toEqual({ kind: "json" });
    expect(controlFor({})).toEqual({ kind: "json" });
    for (const broken of [null, false, "string", 3, [{ type: "string" }]]) expect(() => controlFor(broken)).toThrow("Invalid action schema");
    expect(() => controlFor({ type: "string", pattern: "^a" })).toThrow("Unsupported action schema keyword: pattern");
    expect(() => controlFor({ type: "tuple" })).toThrow("Unsupported action control: tuple");
  });

  test("scalars carry their choices and bounds", () => {
    expect(controlFor({ type: "string", title: "Name", description: "d", minLength: 1, maxLength: 9, format: "x" })).toEqual({ kind: "string" });
    expect(controlFor({ type: "string", enum: ["low", "high"] })).toEqual({ kind: "string", choices: ["low", "high"] });
    expect(() => controlFor({ type: "string", enum: ["low", 3] })).toThrow("Unsupported choice values");
    expect(() => controlFor({ type: "string", enum: "low" })).toThrow("Unsupported choice values");
    expect(controlFor({ type: "integer", minimum: 1, maximum: 9 })).toEqual({ kind: "integer", minimum: 1, maximum: 9 });
    expect(controlFor({ type: "number", minimum: "1" })).toEqual({ kind: "number" });
    expect(controlFor({ type: "number", maximum: 0 })).toEqual({ kind: "number", maximum: 0 });
    expect(controlFor({ type: "boolean" })).toEqual({ kind: "boolean" });
    expect(controlFor({ type: "null" })).toEqual({ kind: "null" });
  });

  test("lists, unions and nullable types become their parts", () => {
    expect(controlFor({ type: "array", items: { type: "integer" } })).toEqual({ kind: "array", item: { kind: "integer" } });
    expect(controlFor({ anyOf: [{ type: "string" }, { type: "null" }] })).toEqual({ kind: "union", options: [{ kind: "string" }, { kind: "null" }] });
    expect(controlFor({ type: ["string", "null"], enum: ["a"] })).toEqual({ kind: "union", options: [{ kind: "string", choices: ["a"] }, { kind: "null" }] });
  });

  test("objects list their fields, required ones, hints from descriptions and defaults, and whether more keys are allowed", () => {
    const control = controlFor({
      type: "object", required: ["name"],
      properties: {
        name: { type: "string", description: "What to call it" },
        limit: { type: "integer", default: 5 },
        mode: { type: "string", description: "How", default: "fast" },
        loose: true,
      },
    });
    expect(control).toEqual({
      kind: "object", required: ["name"],
      fields: { name: { kind: "string" }, limit: { kind: "integer" }, mode: { kind: "string" }, loose: { kind: "json" } },
      hints: { name: "What to call it", limit: "Default: 5", mode: "How Default: \"fast\"", loose: "" },
      additional: { kind: "json" },
    });
    expect(controlFor({ type: "object", additionalProperties: false })).toEqual({ kind: "object", fields: {}, required: [], hints: {} });
    expect(controlFor({ type: "object", additionalProperties: { type: "number" }, propertyNames: { type: "string" } }))
      .toEqual({ kind: "object", fields: {}, required: [], hints: {}, additional: { kind: "number" } });
    expect(() => controlFor({ type: "object", propertyNames: { type: "string", format: "uuid" } })).toThrow("Constrained object keys need an advanced editor");
    expect(() => controlFor({ type: "object", propertyNames: { type: "integer" } })).toThrow("Constrained object keys need an advanced editor");
    expect(() => controlFor({ type: "object", required: "name" })).toThrow("Invalid required fields");
    expect(() => controlFor({ type: "object", required: [3] })).toThrow("Invalid required fields");
    expect(() => controlFor({ type: "object", properties: [] })).toThrow("Expected a schema object");
  });

  test("references reach into the schema's own definitions, and only alone", () => {
    const root = { $defs: { Mode: { type: "string", enum: ["a", "b"] } }, type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } };
    expect(controlFor(root)).toEqual({ kind: "object", fields: { mode: { kind: "string", choices: ["a", "b"] } }, required: [], hints: { mode: "" }, additional: { kind: "json" } });
    expect(() => controlFor({ $ref: "#/components/Mode" })).toThrow("Unsupported schema reference: #/components/Mode");
    expect(() => controlFor({ $ref: "#/$defs/Mode", description: "with company" })).toThrow("Unsupported schema reference: #/$defs/Mode");
    const looping = { $defs: { Loop: { type: "array", items: { $ref: "#/$defs/Loop" } } }, $ref: "#/$defs/Loop" };
    expect(() => controlFor(looping.$defs.Loop, looping)).toThrow("Recursive action schemas need a dedicated control");
    expect(controlFor({ type: "string" }, {}, 24)).toEqual({ kind: "string" });
    expect(() => controlFor({ type: "string" }, {}, 25)).toThrow("Recursive action schemas need a dedicated control");
    const nested = (levels: number): unknown => levels === 0 ? { type: "string" } : { type: "array", items: nested(levels - 1) };
    expect(() => controlFor(nested(24)), "two dozen levels deep from the top").not.toThrow();
    expect(() => controlFor(nested(25))).toThrow("Recursive action schemas need a dedicated control");
    expect(() => controlFor({ $ref: "#/$defs/Mode" }, {})).toThrow("Expected a schema object");
    expect(() => controlFor({ type: "object", propertyNames: "x" })).toThrow("Expected a schema object");
    expect(() => controlFor({ type: "string", enum: ["a", 1] })).toThrow("Unsupported choice values");
    expect(() => controlFor({ type: "string", enum: "a" })).toThrow("Unsupported choice values");
  });
});

describe("an action's form", () => {
  test("takes an object whose fields are exactly the ones the action describes", () => {
    const input = { type: "object", required: ["name"], properties: { name: { type: "string" }, label: { type: "string" } } };
    expect(actionControl(operation(input, ["label", "name"])).fields).toEqual({ name: { kind: "string" }, label: { kind: "string" } });
    expect(() => actionControl(operation({ type: "string" }, []))).toThrow("Action rename_thread requires object arguments");
    expect(() => actionControl(operation(input, ["name"]))).toThrow("Unaccounted GUI fields: rename_thread");
    expect(() => actionControl(operation(input, ["name", "label", "extra"]))).toThrow("Unaccounted GUI fields: rename_thread");
  });

  test("starts each control at its first choice, its minimum or empty, and fills only required fields", () => {
    expect(initialValue({ kind: "json" })).toBe("");
    expect(initialValue({ kind: "string" })).toBe("");
    expect(initialValue({ kind: "string", choices: ["low", "high"] })).toBe("low");
    expect(initialValue({ kind: "integer", minimum: 3 })).toBe(3);
    expect(initialValue({ kind: "number" })).toBe(0);
    expect(initialValue({ kind: "boolean" })).toBe(false);
    expect(initialValue({ kind: "null" })).toBeNull();
    expect(initialValue({ kind: "array", item: { kind: "string" } })).toEqual([]);
    expect(initialValue({ kind: "union", options: [{ kind: "integer", minimum: 2 }, { kind: "null" }] })).toBe(2);
    expect(() => initialValue({ kind: "union", options: [] })).toThrow("Empty control union");
    const object: Control = { kind: "object", fields: { name: { kind: "string" }, limit: { kind: "integer", minimum: 1 } }, required: ["limit"] };
    expect(initialValue(object)).toEqual({ limit: 1 });
    expect(() => initialValue({ kind: "object", fields: {}, required: ["ghost"] })).toThrow("Missing required control: ghost");
  });

  test("a value fits a control only if it is that kind, or any kind a union allows", () => {
    const cases: [Control, unknown[], unknown[]][] = [
      [{ kind: "json" }, ["x", 1, null, {}], []],
      [{ kind: "string" }, ["x"], [1, null]],
      [{ kind: "integer" }, [1], ["1"]],
      [{ kind: "number" }, [1.5], [true]],
      [{ kind: "boolean" }, [false], [0]],
      [{ kind: "null" }, [null], [undefined, 0]],
      [{ kind: "array", item: { kind: "string" } }, [[]], [{}]],
      [{ kind: "object", fields: {}, required: [] }, [{}], [null, [], "x"]],
      [{ kind: "union", options: [{ kind: "string" }, { kind: "null" }] }, ["x", null], [1]],
    ];
    for (const [control, fits, misfits] of cases) {
      for (const value of fits) expect(acceptsKind(control, value), `${control.kind} takes ${JSON.stringify(value)}`).toBe(true);
      for (const value of misfits) expect(acceptsKind(control, value), `${control.kind} refuses ${JSON.stringify(value)}`).toBe(false);
    }
  });
});
