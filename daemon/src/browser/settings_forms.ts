import type { ConfigSchemaEntry } from "../protocol/ConfigSchemaEntry.ts";
import type { Control } from "./forms.ts";

export function settingControl(entry: ConfigSchemaEntry): Control {
  switch (entry.kind) {
    case "boolean": return { kind: "boolean" };
    case "string": case "duration": return { kind: "string" };
    case "integer": return { kind: "integer", minimum: 0, maximum: entry.width === "u32" ? 0xffff_ffff : Number.MAX_SAFE_INTEGER };
    case "float": return { kind: "number" };
    case "enum": {
      if (entry.values.length === 0) throw new Error(`Missing setting choices: ${entry.key}`);
      return { kind: "string", choices: entry.values };
    }
    case "list": {
      if (entry.item_kind === undefined || ["list", "table", "map", "unknown"].includes(entry.item_kind)) throw new Error(`Unsupported setting collection: ${entry.key}`);
      return { kind: "array", item: settingControl({ ...entry, kind: entry.item_kind }) };
    }
    default: throw new Error(`Unsupported editable setting: ${entry.key} (${entry.kind})`);
  }
}

export function settingText(entry: ConfigSchemaEntry, value: unknown): string {
  if (entry.kind === "list") {
    if (!Array.isArray(value)) throw new Error("Choose a collection of values");
    return JSON.stringify(value);
  }
  if (entry.kind === "integer" || entry.kind === "float") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Enter a finite number");
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error("Enter a value before saving");
  return String(value);
}

export function configAt(value: unknown, key: string): unknown {
  let current = value;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, part)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function assertSettingsCoverage(entries: ConfigSchemaEntry[], renderers: ReadonlySet<string>): void {
  const visit = (control: Control): void => {
    if (!renderers.has(control.kind)) throw new Error(`Missing settings renderer: ${control.kind}`);
    if (control.kind === "array") visit(control.item);
  };
  for (const entry of entries) {
    if (entry.settable) visit(settingControl(entry));
    else if (entry.key.includes("<index>")) continue;
    else if (!["map", "table", "list"].includes(entry.kind)) throw new Error(`Unaccounted read-only setting: ${entry.key}`);
  }
}
