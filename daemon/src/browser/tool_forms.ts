import type { ToolAccessResult } from "../protocol/ToolAccessResult.ts";
import { controlFor, type Control } from "./forms.ts";

export function toolNames(access: ToolAccessResult): string[] {
  return [...new Set([...access.tools.map((tool) => tool.tool), ...access.subagents.map((agent) => `ask_${agent.name}`), ...access.mcp])].sort();
}

export function toolControl(schema: unknown): Extract<Control, { kind: "object" }> {
  const control = controlFor(schema);
  if (control.kind !== "object") throw new Error("Tool arguments require an object editor");
  const multiline = (field: Control): void => {
    if (field.kind === "string" && field.choices === undefined) field.multiline = true;
    if (field.kind === "array") multiline(field.item);
    if (field.kind === "union") field.options.forEach(multiline);
    if (field.kind === "object") {
      Object.values(field.fields).forEach(multiline);
      if (field.additional !== undefined) multiline(field.additional);
    }
  };
  multiline(control);
  return control;
}

export function assertToolControlCoverage(schemas: readonly { name: string; schema: unknown }[], renderers: ReadonlySet<string>): void {
  const check = (name: string, control: Control): void => {
    if (!renderers.has(control.kind)) throw new Error(`Missing tool input renderer: ${name}.${control.kind}`);
    if (control.kind === "array") check(name, control.item);
    if (control.kind === "union") control.options.forEach((option) => check(name, option));
    if (control.kind === "object") {
      Object.values(control.fields).forEach((field) => check(name, field));
      if (control.additional !== undefined) check(name, control.additional);
    }
  };
  for (const schema of schemas) check(schema.name, toolControl(schema.schema));
}
