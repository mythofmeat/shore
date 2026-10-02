import type { ReactNode } from "react";
import { fieldLabel } from "../ui/Field.tsx";

function scalarText(value: unknown): string | undefined {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    if (value === "") return "(empty)";
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)) { const date = new Date(value); if (!Number.isNaN(date.getTime())) return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }); }
    return value;
  }
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return undefined;
}

export function Tree({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  const scalar = scalarText(value);
  if (scalar !== undefined) return <span className={typeof value === "string" && value.includes("/") ? "mono" : ""}>{scalar}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">None</span>;
    if (value.every((item) => scalarText(item) !== undefined)) return <span>{value.map((item) => scalarText(item)).join(", ")}</span>;
    return <ol className="tree-list">{value.map((item, index) => <li key={index}><Tree value={item} depth={depth + 1} /></li>)}</ol>;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="muted">None</span>;
  if (depth > 5) return <span className="mono">{JSON.stringify(value)}</span>;
  return <dl className="kv tree">{entries.map(([key, item]) => <div key={key} className="kv-row"><dt>{fieldLabel(key)}</dt><dd><Tree value={item} depth={depth + 1} /></dd></div>)}</dl>;
}
