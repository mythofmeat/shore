import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({
  addUsedSchema: false,
  allowUnionTypes: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: true,
});
addFormats(ajv);

export class InvalidToolSchema extends Error {
  constructor(tool: string, reason: string) {
    super(`invalid JSON Schema for tool '${tool}': ${reason}`);
    this.name = "InvalidToolSchema";
  }
}

export class CompiledToolSchema {
  readonly schema: Record<string, unknown>;
  readonly validate: ValidateFunction;

  constructor(schema: Record<string, unknown>, validate: ValidateFunction) {
    this.schema = schema;
    this.validate = validate;
  }
}

export type ToolSchemas = ReadonlyMap<string, CompiledToolSchema>;

const compiledSchemas = new WeakMap<Record<string, unknown>, CompiledToolSchema>();

export function compileToolSchema(tool: string, schema: unknown): CompiledToolSchema {
  if (!isSchemaObject(schema)) {
    throw new InvalidToolSchema(tool, "the schema must be a JSON object");
  }

  const cached = compiledSchemas.get(schema);
  if (cached !== undefined) return cached;

  try {
    const compiled = new CompiledToolSchema(schema, ajv.compile(schema));
    compiledSchemas.set(schema, compiled);
    return compiled;
  } catch (error) {
    throw new InvalidToolSchema(tool, error instanceof Error ? error.message : String(error));
  }
}

export function schemasFrom(
  defs: readonly { name: string; input_schema: unknown }[] | undefined,
): ToolSchemas {
  const map = new Map<string, CompiledToolSchema>();
  for (const def of defs ?? []) {
    if (map.has(def.name)) {
      throw new InvalidToolSchema(def.name, "the tool name was registered more than once");
    }
    map.set(def.name, compileToolSchema(def.name, def.input_schema));
  }
  return map;
}

export function schemaViolation(
  schema: CompiledToolSchema | Record<string, unknown> | undefined,
  input: unknown,
): string | undefined {
  if (schema === undefined) return undefined;
  if (!isJsonObject(input)) {
    return `the arguments must be a JSON object, not ${describeJson(input)}`;
  }

  const compiled =
    schema instanceof CompiledToolSchema ? schema : compileToolSchema("<anonymous>", schema);
  if (compiled.validate(input)) return undefined;

  const errors = compiled.validate.errors ?? [];
  if (errors.length === 0) return "the arguments did not match the tool's JSON Schema";
  return errors.map(describeValidationError).join("; ");
}

function describeValidationError(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missing = stringParam(error, "missingProperty");
    return `the required argument ${quotePath(error.instancePath, missing)} was missing`;
  }
  if (error.keyword === "additionalProperties") {
    const extra = stringParam(error, "additionalProperty");
    return `argument ${quotePath(error.instancePath, extra)} is not allowed`;
  }

  const path = quotePath(error.instancePath);
  if (error.keyword === "type") {
    const expected = stringParam(error, "type");
    return `argument ${path} must be ${article(expected)} ${expected}`;
  }
  if (error.keyword === "enum") {
    const allowedValues = errorParam(error, "allowedValues");
    const allowed = Array.isArray(allowedValues)
      ? allowedValues.map((value) => JSON.stringify(value)).join(", ")
      : "one of the declared values";
    return `argument ${path} must be one of ${allowed}`;
  }
  if (error.keyword === "format") {
    const format = stringParam(error, "format");
    return `argument ${path} must match the ${JSON.stringify(format)} format`;
  }

  return `argument ${path} ${error.message ?? `failed the ${error.keyword} constraint`}`;
}

function quotePath(instancePath: string, child?: string): string {
  const parts = instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (child !== undefined && child !== "") parts.push(child);
  if (parts.length === 0) return "`<root>`";

  let out = "";
  for (const part of parts) {
    out += /^\d+$/.test(part) ? `[${part}]` : `${out === "" ? "" : "."}${part}`;
  }
  return `\`${out}\``;
}

function stringParam(error: ErrorObject, name: string): string {
  const value = errorParam(error, name);
  return typeof value === "string" ? value : "";
}

function errorParam(error: ErrorObject, name: string): unknown {
  const params = error.params as Record<string, unknown>;
  return params[name];
}

function article(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
