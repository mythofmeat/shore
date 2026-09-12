import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";

export type Control =
  | { kind: "json" }
  | { kind: "string"; choices?: string[]; multiline?: boolean }
  | { kind: "integer" | "number"; minimum?: number; maximum?: number }
  | { kind: "boolean" | "null" }
  | { kind: "array"; item: Control }
  | { kind: "union"; options: Control[] }
  | { kind: "object"; fields: Record<string, Control>; required: string[]; additional?: Control; hints?: Record<string, string> };

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a schema object");
  return value as Record<string, unknown>;
}

const keywords = new Set(["$schema", "$defs", "$ref", "title", "description", "default", "type", "properties", "additionalProperties", "propertyNames", "required", "enum", "anyOf", "items", "minimum", "maximum", "minLength", "maxLength", "format"]);

export function controlFor(schema: unknown, root: unknown = schema, depth = 0): Control {
  if (depth > 24) throw new Error("Recursive action schemas need a dedicated control");
  if (schema === true) return { kind: "json" };
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Invalid action schema");
  const node = record(schema);
  if (Object.keys(node).length === 0) return { kind: "json" };
  for (const key of Object.keys(node)) if (!keywords.has(key)) throw new Error(`Unsupported action schema keyword: ${key}`);
  const next = (value: unknown) => controlFor(value, root, depth + 1);
  if (typeof node["$ref"] === "string") {
    const ref = node["$ref"];
    if (!ref.startsWith("#/$defs/") || Object.keys(node).length !== 1) throw new Error(`Unsupported schema reference: ${ref}`);
    return next(record(record(root)["$defs"])[ref.slice(8)]);
  }
  if (Array.isArray(node["anyOf"])) return { kind: "union", options: node["anyOf"].map(next) };
  if (Array.isArray(node["type"])) return { kind: "union", options: node["type"].map((type: unknown) => next({ ...node, type })) };
  switch (node["type"]) {
    case "string": {
      const choices = node["enum"];
      if (choices !== undefined && (!Array.isArray(choices) || !choices.every((value) => typeof value === "string"))) throw new Error("Unsupported choice values");
      return { kind: "string", ...(choices === undefined ? {} : { choices: choices.map((value: unknown) => {
        if (typeof value !== "string") throw new Error("Expected a string choice");
        return value;
      }) }) };
    }
    case "integer": case "number":
      return { kind: node["type"], ...(typeof node["minimum"] === "number" ? { minimum: node["minimum"] } : {}), ...(typeof node["maximum"] === "number" ? { maximum: node["maximum"] } : {}) };
    case "boolean": return { kind: "boolean" };
    case "null": return { kind: "null" };
    case "array": return { kind: "array", item: next(node["items"]) };
    case "object": {
      if (node["propertyNames"] !== undefined) {
        const keys = record(node["propertyNames"]);
        if (keys["type"] !== "string" || Object.keys(keys).length !== 1) throw new Error("Constrained object keys need an advanced editor");
      }
      const required = node["required"] ?? [];
      if (!Array.isArray(required) || !required.every((value) => typeof value === "string")) throw new Error("Invalid required fields");
      const properties = Object.entries(record(node["properties"] ?? {}));
      const hints = Object.fromEntries(properties.map(([key, value]) => {
        const field = value !== null && typeof value === "object" && !Array.isArray(value) ? record(value) : {};
        const parts = [typeof field["description"] === "string" ? field["description"] : "", Object.hasOwn(field, "default") ? `Default: ${JSON.stringify(field["default"])}` : ""];
        return [key, parts.filter(Boolean).join(" ")];
      }));
      return { kind: "object", fields: Object.fromEntries(properties.map(([key, value]) => [key, next(value)])), required, hints, ...(node["additionalProperties"] === false ? {} : { additional: next(node["additionalProperties"] ?? true) }) };
    }
    default: throw new Error(`Unsupported action control: ${String(node["type"])}`);
  }
}

export function actionControl(operation: OperationDescriptor): Extract<Control, { kind: "object" }> {
  const control = controlFor(operation.input);
  if (control.kind !== "object") throw new Error(`Action ${operation.name} requires object arguments`);
  const fields = Object.keys(control.fields).sort().join(",");
  if (fields !== Object.keys(operation.fields).sort().join(",")) throw new Error(`Unaccounted GUI fields: ${operation.name}`);
  return control;
}

export function initialValue(control: Control): unknown {
  switch (control.kind) {
    case "json": return "";
    case "string": return control.choices?.at(0) ?? "";
    case "number": case "integer": return control.minimum ?? 0;
    case "boolean": return false;
    case "null": return null;
    case "array": return [];
    case "object": return Object.fromEntries(control.required.map((key) => {
      const field = control.fields[key];
      if (field === undefined) throw new Error(`Missing required control: ${key}`);
      return [key, initialValue(field)];
    }));
    case "union": {
      const first = control.options.at(0);
      if (first === undefined) throw new Error("Empty control union");
      return initialValue(first);
    }
  }
}

export function acceptsKind(control: Control, value: unknown): boolean {
  switch (control.kind) {
    case "json": return true;
    case "string": return typeof value === "string";
    case "number": case "integer": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "union": return control.options.some((option) => acceptsKind(option, value));
  }
}
