import { ConfigDuration } from "./duration.ts";
import type { SchemaEntry } from "./schema.ts";

export class SchemaValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValueError";
  }
}

const TRUE = new Set(["true", "yes", "on", "1"]);
const FALSE = new Set(["false", "no", "off", "0"]);

const U32_MAX = 0xffff_ffff;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function boolLiteral(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  if (TRUE.has(lowered)) return "true";
  if (FALSE.has(lowered)) return "false";
  throw new SchemaValueError(`expected true or false, got ${JSON.stringify(raw)}`);
}

function integerLiteral(raw: string, width: SchemaEntry["width"]): string {
  const trimmed = raw.trim().replaceAll("_", "");
  if (!/^\d+$/.test(trimmed)) {
    throw new SchemaValueError(`expected a whole number, got ${JSON.stringify(raw)}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new SchemaValueError(`${JSON.stringify(raw)} is too large`);
  }
  if (width === "u32" && value > U32_MAX) {
    throw new SchemaValueError(`${value} exceeds the maximum for u32 (${U32_MAX})`);
  }
  return String(value);
}

function floatLiteral(raw: string): string {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(value)) {
    throw new SchemaValueError(`expected a number, got ${JSON.stringify(raw)}`);
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function durationLiteral(raw: string): string {
  const parsed = ConfigDuration.deserialize(raw.trim());
  if ("err" in parsed) {
    throw new SchemaValueError(
      `${parsed.err} — durations look like \`30s\`, \`5m\`, \`1h\`, \`7d\``,
    );
  }
  return tomlString(parsed.ok.toString());
}

function enumLiteral(raw: string, variants: readonly string[]): string {
  const trimmed = raw.trim();
  if (!variants.includes(trimmed)) {
    throw new SchemaValueError(
      `${JSON.stringify(raw)} is not one of: ${variants.join(", ")}`,
    );
  }
  return tomlString(trimmed);
}

function splitList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((part) => part !== "");
}

function scalarLiteral(entry: SchemaEntry, kind: SchemaEntry["kind"], raw: string): string {
  switch (kind) {
    case "boolean":
      return boolLiteral(raw);
    case "string":
      return tomlString(raw);
    case "integer":
      return integerLiteral(raw, entry.width);
    case "float":
      return floatLiteral(raw);
    case "duration":
      return durationLiteral(raw);
    case "enum":
      return enumLiteral(raw, entry.values);
    default:
      throw new SchemaValueError(`\`${entry.key}\` is a ${entry.type} and cannot be set as text`);
  }
}

export function schemaValueLiteral(entry: SchemaEntry, raw: string): string {
  if (!entry.settable) {
    throw new SchemaValueError(
      `\`${entry.key}\` is a ${entry.type}; set its individual fields instead`,
    );
  }
  if (entry.kind !== "list") return scalarLiteral(entry, entry.kind, raw);

  const items = splitList(raw).map((item) =>
    scalarLiteral(entry, entry.item_kind ?? "string", item),
  );
  return `[${items.join(", ")}]`;
}
