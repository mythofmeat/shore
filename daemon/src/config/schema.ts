import {
  appConfigShape,
  CATALOG_SECTIONS,
  type ConfigTypeInfo,
  type ConfigValueSource,
} from "./app.ts";
import { requiresRestart } from "./restart.ts";

export interface SchemaEntry {
  key: string;
  kind: ConfigTypeInfo["kind"];
  item_kind: ConfigTypeInfo["kind"] | undefined;
  width: "usize" | "u32" | "u64" | undefined;
  type: string;
  settable: boolean;
  optional: boolean;
  restart_required: boolean;
  values: readonly string[];
  source: ConfigValueSource | undefined;
  key_source: ConfigValueSource | undefined;
}

const DURATION_EXAMPLES = ["0s", "30s", "5m", "1h", "12h", "7d"] as const;
const BOOLEANS = ["true", "false"] as const;

function describe(info: ConfigTypeInfo): string {
  switch (info.kind) {
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "integer":
      return info.width ?? "integer";
    case "float":
      return "number";
    case "duration":
      return "duration";
    case "enum":
      return (info.variants ?? []).join(" | ");
    case "list":
      return `list of ${info.item === undefined ? "values" : describe(info.item)}`;
    case "map":
      return `table of ${info.item === undefined ? "values" : describe(info.item)}`;
    case "table":
      return "table";
    case "unknown":
      return "value";
  }
}

function candidates(info: ConfigTypeInfo): readonly string[] {
  switch (info.kind) {
    case "boolean":
      return BOOLEANS;
    case "enum":
      return info.variants ?? [];
    case "duration":
      return DURATION_EXAMPLES;
    case "list":
      return info.item === undefined ? [] : candidates(info.item);
    default:
      return [];
  }
}

function scalar(info: ConfigTypeInfo): boolean {
  switch (info.kind) {
    case "boolean":
    case "string":
    case "integer":
    case "float":
    case "duration":
    case "enum":
      return true;
    default:
      return false;
  }
}

function settable(info: ConfigTypeInfo): boolean {
  if (scalar(info)) return true;
  return info.kind === "list" && info.item !== undefined && scalar(info.item);
}

function sourceOf(info: ConfigTypeInfo): ConfigValueSource | undefined {
  if (info.source !== undefined) return info.source;
  return info.kind === "list" ? info.item?.source : undefined;
}

function entry(key: string, info: ConfigTypeInfo): SchemaEntry {
  return {
    key,
    kind: info.kind,
    item_kind: info.item?.kind,
    width: info.kind === "list" ? info.item?.width : info.width,
    type: describe(info),
    settable: settable(info),
    optional: info.optional === true,
    restart_required: requiresRestart(key),
    values: candidates(info),
    source: sourceOf(info),
    key_source: info.keySource,
  };
}

export interface LiveInstances {
  instancesAt(key: string): readonly string[];
}

function walk(prefix: string, info: ConfigTypeInfo, live: LiveInstances, out: SchemaEntry[]): void {
  const key = prefix;
  out.push(entry(key, info));

  if (info.kind === "table") {
    const shape = info.table?.();
    if (shape === undefined) return;
    for (const [field, child] of Object.entries(shape.fields)) {
      walk(`${key}.${field}`, child, live, out);
    }
    return;
  }

  if (info.kind === "map" && info.item !== undefined) {
    for (const instance of live.instancesAt(key)) {
      walk(`${key}.${instance}`, info.item, live, out);
    }
  }
}

export function configSchema(live: LiveInstances): SchemaEntry[] {
  const shape = appConfigShape();
  const out: SchemaEntry[] = [];
  for (const [field, info] of Object.entries(shape.fields)) {
    walk(field, info, live, out);
  }
  for (const section of CATALOG_SECTIONS) {
    out.push({
      key: section,
      kind: "map",
      item_kind: "table",
      width: undefined,
      type: "catalog section",
      settable: false,
      optional: false,
      restart_required: false,
      values: [],
      source: undefined,
      key_source: undefined,
    });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

export function findSchemaEntry(entries: readonly SchemaEntry[], key: string): SchemaEntry | undefined {
  return entries.find((e) => e.key === key);
}
