import { useId, useState, type ReactNode } from "react";
import { initialValue, acceptsKind, type Control, type ControlKind } from "../forms.ts";
import { IconButton, Switch } from "./controls.tsx";
import { fieldLabel } from "./labels.ts";

export { fieldLabel } from "./labels.ts";


type ControlFor<K extends ControlKind> = Control extends infer C ? C extends { kind: infer Kinds } ? K extends Kinds ? C : never : never : never;
type FieldProps<K extends ControlKind> = { control: ControlFor<K>; value: unknown; change: (value: unknown) => void; label: string; id: string; secret?: boolean };

function TextField({ control, value, change, label, id, secret = false }: FieldProps<"string">) {
  const text = typeof value === "string" ? value : "";
  if (control.choices !== undefined) return <select id={id} className="select" aria-label={label} value={text} onChange={(event) => change(event.target.value)}>
    {control.choices.includes(text) ? null : <option value={text}>{text === "" ? "Choose…" : text}</option>}
    {control.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
  </select>;
  if (control.multiline === true) return <textarea id={id} className="input textarea" aria-label={label} rows={3} value={text} onChange={(event) => change(event.target.value)} />;
  return <input id={id} className="input" aria-label={label} type={secret ? "password" : "text"} autoComplete="off" value={text} onChange={(event) => change(event.target.value)} />;
}

function NumberField({ control, value, change, label, id }: FieldProps<"integer" | "number">) {
  const [text, setText] = useState(typeof value === "number" ? String(value) : "");
  return <input id={id} className="input compact" aria-label={label} inputMode={control.kind === "integer" ? "numeric" : "decimal"} value={text}
    onChange={(event) => {
      setText(event.target.value);
      const trimmed = event.target.value.trim();
      if (trimmed === "") { change(undefined); return; }
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && (control.kind !== "integer" || Number.isInteger(parsed))) change(parsed);
    }} min={control.minimum} max={control.maximum} />;
}

function BooleanField({ value, change, label }: FieldProps<"boolean">) {
  return <Switch label={label} checked={value === true} change={change} />;
}

function NullField(_: FieldProps<"null">) {
  return <span className="muted">No value</span>;
}

function JsonField({ value, change, label, id }: FieldProps<"json">) {
  const [text, setText] = useState(() => value === undefined || value === "" ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  return <div className="field-stack">
    <textarea id={id} className="input textarea mono" aria-label={label} rows={4} value={text} onChange={(event) => {
      setText(event.target.value);
      if (event.target.value.trim() === "") { setError(""); change(undefined); return; }
      try { change(JSON.parse(event.target.value)); setError(""); } catch { setError("Enter valid JSON"); }
    }} />
    {error === "" ? null : <span className="form-error">{error}</span>}
  </div>;
}

function ArrayField({ control, value, change, label, id }: FieldProps<"array">) {
  const items: unknown[] = Array.isArray(value) ? value as unknown[] : [];
  return <div className="field-stack">
    {items.map((item, index) => <div key={index} className="field-array-row">
      <Field control={control.item} value={item} change={(next) => change(items.map((existing, position) => position === index ? next : existing))} label={`${label} ${String(index + 1)}`} id={`${id}-${String(index)}`} />
      <IconButton icon="close" label={`Remove ${label} ${String(index + 1)}`} onClick={() => change(items.filter((_, position) => position !== index))} />
    </div>)}
    <button type="button" className="button ghost field-add" onClick={() => change([...items, initialValue(control.item)])}>Add {items.length === 0 ? "an item" : "another"}</button>
  </div>;
}

function ObjectField({ control, value, change, id }: FieldProps<"object">) {
  const current = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const set = (key: string, next: unknown) => {
    const copy = { ...current };
    if (next === undefined || (next === "" && !control.required.includes(key))) delete copy[key]; else copy[key] = next;
    change(copy);
  };
  const extra = Object.keys(current).filter((key) => control.fields[key] === undefined);
  return <div className="field-object">
    {Object.entries(control.fields).map(([key, field]) => <FieldRow key={key} name={key} required={control.required.includes(key)} hint={control.hints?.[key]} control={field} value={current[key]} change={(next) => set(key, next)} id={`${id}-${key}`} />)}
    {control.additional === undefined || (control.additional.kind === "json" && Object.keys(control.fields).length > 0) ? null : <AdditionalFields control={control.additional} keys={extra} value={current} change={change} id={id} />}
  </div>;
}

function AdditionalFields({ control, keys, value, change, id }: { control: Control; keys: string[]; value: Record<string, unknown>; change: (value: unknown) => void; id: string }) {
  const [name, setName] = useState("");
  return <div className="field-stack">
    {keys.map((key) => <div key={key} className="field-array-row">
      <FieldRow name={key} required={false} control={control} value={value[key]} change={(next) => change({ ...value, [key]: next })} id={`${id}-extra-${key}`} />
      <IconButton icon="close" label={`Remove ${key}`} onClick={() => { const copy = { ...value }; delete copy[key]; change(copy); }} />
    </div>)}
    <div className="field-array-row">
      <input className="input" aria-label="New entry name" placeholder="Entry name" value={name} onChange={(event) => setName(event.target.value)} />
      <button type="button" className="button" disabled={name.trim() === "" || Object.hasOwn(value, name.trim())} onClick={() => { change({ ...value, [name.trim()]: initialValue(control) }); setName(""); }}>Add entry</button>
    </div>
  </div>;
}

function unionLabel(control: Control): string {
  switch (control.kind) {
    case "string": return control.choices === undefined ? "Text" : "Choice";
    case "integer": return "Whole number";
    case "number": return "Number";
    case "boolean": return "Yes or no";
    case "null": return "Nothing";
    case "array": return "List";
    case "object": return "Group";
    case "json": return "JSON";
    case "union": return "Other";
  }
}

function UnionField({ control, value, change, label, id }: FieldProps<"union">) {
  const found = control.options.findIndex((option) => value !== undefined && acceptsKind(option, value));
  const [selected, setSelected] = useState(found < 0 ? 0 : found);
  const option = control.options[selected];
  if (option === undefined) return null;
  return <div className="field-stack">
    {control.options.length > 1 ? <div className="segmented" role="radiogroup" aria-label={`${label} type`}>
      {control.options.map((item, index) => <button key={index} type="button" role="radio" aria-checked={index === selected} onClick={() => { setSelected(index); change(item.kind === "null" ? null : undefined); }}>{unionLabel(item)}</button>)}
    </div> : null}
    <Field control={option} value={acceptsKind(option, value) ? value : undefined} change={change} label={label} id={id} />
  </div>;
}

const RENDERERS: { [K in ControlKind]: (props: FieldProps<K>) => ReactNode } = {
  string: TextField, integer: NumberField, number: NumberField, boolean: BooleanField, null: NullField,
  json: JsonField, array: ArrayField, object: ObjectField, union: UnionField,
};

export function Field({ control, value, change, label, id, secret }: { control: Control; value: unknown; change: (value: unknown) => void; label: string; id: string; secret?: boolean }) {
  const Renderer = RENDERERS[control.kind] as (props: FieldProps<ControlKind>) => ReactNode;
  return <Renderer control={control} value={value} change={change} label={label} id={id} {...(secret === undefined ? {} : { secret })} />;
}

export function FieldRow({ name, label, required, hint, control, value, change, id, secret }: { name: string; label?: string; required: boolean; hint?: string | undefined; control: Control; value: unknown; change: (value: unknown) => void; id?: string; secret?: boolean }) {
  const generated = useId();
  const fieldId = id ?? generated;
  const text = label ?? fieldLabel(name);
  const block = control.kind === "object" || control.kind === "array" || control.kind === "union" || control.kind === "json" || (control.kind === "string" && control.multiline === true);
  return <div className={`field-row ${block ? "block" : ""}`}>
    <label className="field-label" htmlFor={fieldId}>{text}{required ? null : <span className="muted"> (optional)</span>}</label>
    {hint === undefined || hint === "" ? null : <span className="field-hint">{hint}</span>}
    <div className="field-input"><Field control={control} value={value} change={change} label={text} id={fieldId} {...(secret === undefined ? {} : { secret })} /></div>
  </div>;
}
