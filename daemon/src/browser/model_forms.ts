import type { ModelSettingSchemaEntry } from "../protocol/ModelSettingSchemaEntry.ts";
import type { Control } from "./forms.ts";

export function modelSettingControl(entry: ModelSettingSchemaEntry): Control {
  switch (entry.kind) {
    case "number": return { kind: "number" };
    case "u32": return { kind: "integer", minimum: 0, maximum: 0xffff_ffff };
    case "boolean": return { kind: "boolean" };
    case "duration": case "duration_or_off": return { kind: "string" };
    case "string": {
      if (!entry.allow_custom && entry.suggestions.length === 0) throw new Error(`Missing choices for ${entry.key}`);
      return { kind: "string", ...(entry.allow_custom ? {} : { choices: entry.suggestions }) };
    }
    case "json_object": return { kind: "json" };
    default: throw new Error(`Unsupported model setting kind: ${String(entry.kind)}`);
  }
}

export function assertModelSettingsCoverage(entries: ModelSettingSchemaEntry[], renderers: ReadonlySet<string>): void {
  for (const entry of entries) {
    const control = modelSettingControl(entry);
    if (!renderers.has(control.kind)) throw new Error(`Missing model setting renderer: ${control.kind}`);
  }
}
