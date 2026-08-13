export type ToolSchemas = ReadonlyMap<string, unknown>;

export function schemasFrom(
  defs: readonly { name: string; input_schema: unknown }[] | undefined,
): ToolSchemas {
  const map = new Map<string, unknown>();
  for (const def of defs ?? []) map.set(def.name, def.input_schema);
  return map;
}

export function schemaViolation(schema: unknown, input: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const shape = schema as { type?: unknown; required?: unknown };
  if (shape.type !== "object") return undefined;

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return `the arguments must be a JSON object, not ${describeJson(input)}`;
  }

  const required = Array.isArray(shape.required) ? shape.required : [];
  const record = input as Record<string, unknown>;
  const missing = required.filter(
    (key): key is string => typeof key === "string" && record[key] === undefined,
  );
  if (missing.length === 0) return undefined;
  return `the required argument${missing.length > 1 ? "s" : ""} ${missing
    .map((k) => `\`${k}\``)
    .join(", ")} ${missing.length > 1 ? "were" : "was"} missing`;
}

function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
