import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Texts } from "../texts/texts.ts";

const ajvOptions = {
  addUsedSchema: false,
  allowUnionTypes: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: true,
} as const;

const ajvDraft07 = new Ajv(ajvOptions);
const ajv202012 = new Ajv2020(ajvOptions);
addFormats(ajvDraft07);
addFormats(ajv202012);

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

  const validator = validatorFor(tool, schema);
  try {
    const compiled = new CompiledToolSchema(schema, validator.compile(schema));
    compiledSchemas.set(schema, compiled);
    return compiled;
  } catch (error) {
    throw new InvalidToolSchema(tool, error instanceof Error ? error.message : String(error));
  }
}

function validatorFor(tool: string, schema: Record<string, unknown>): Ajv | Ajv2020 {
  const dialect = schema.$schema;
  if (dialect === undefined || is202012Dialect(dialect)) return ajv202012;
  if (isDraft07Dialect(dialect)) return ajvDraft07;

  const declared = typeof dialect === "string" ? JSON.stringify(dialect) : describeJson(dialect);
  throw new InvalidToolSchema(
    tool,
    `unsupported JSON Schema dialect ${declared}; supported dialects are draft-07 and 2020-12`,
  );
}

function isDraft07Dialect(dialect: unknown): boolean {
  return (
    dialect === "http://json-schema.org/draft-07/schema" ||
    dialect === "http://json-schema.org/draft-07/schema#"
  );
}

function is202012Dialect(dialect: unknown): boolean {
  return (
    dialect === "https://json-schema.org/draft/2020-12/schema" ||
    dialect === "https://json-schema.org/draft/2020-12/schema#"
  );
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
  texts: Texts,
  schema: CompiledToolSchema | Record<string, unknown> | undefined,
  input: unknown,
): string | undefined {
  if (schema === undefined) return undefined;
  if (!isJsonObject(input)) return texts.always("tool_arg_not_object", { given: describeJson(input) });

  const compiled =
    schema instanceof CompiledToolSchema ? schema : compileToolSchema("<anonymous>", schema);
  if (compiled.validate(input)) return undefined;

  const errors = compiled.validate.errors ?? [];
  if (errors.length === 0) return texts.always("tool_arg_mismatch");
  return errors.map((error) => describeValidationError(texts, error)).join("; ");
}

function describeValidationError(texts: Texts, error: ErrorObject): string {
  if (error.keyword === "required") return texts.always("tool_arg_missing", { argument: quotePath(error.instancePath, stringParam(error, "missingProperty")) });
  if (error.keyword === "additionalProperties") return texts.always("tool_arg_extra", { argument: quotePath(error.instancePath, stringParam(error, "additionalProperty")) });

  const argument = quotePath(error.instancePath);
  if (error.keyword === "type") {
    const type = stringParam(error, "type");
    return texts.always("tool_arg_type", { argument, an: /^[aeiou]/i.test(type) ? "yes" : undefined, type });
  }
  if (error.keyword === "enum") {
    const allowedValues = errorParam(error, "allowedValues");
    return texts.always("tool_arg_enum", { argument, allowed: Array.isArray(allowedValues) ? allowedValues.map((value) => JSON.stringify(value)).join(", ") : undefined });
  }
  if (error.keyword === "format") return texts.always("tool_arg_format", { argument, format: JSON.stringify(stringParam(error, "format")) });
  return texts.always("tool_arg_other", { argument, problem: error.message, keyword: error.keyword });
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
