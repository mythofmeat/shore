import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import type { ContentBlock } from "../protocol/ContentBlock.ts";
import type { OperationField } from "../protocol/OperationField.ts";
import { acceptsKind, initialValue, record, type Control } from "./forms.ts";

export function Inspect({ value, label = "Inspect data" }: { value: unknown; label?: string }) {
  return <details className="inspect"><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} aria-labelledby={heading} onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="modal-heading"><h2 id={heading}>{title}</h2><button aria-label="Close dialog" onClick={close}>Close</button></div>{children}
  </dialog>;
}

export function mediaSource(data: string | null | undefined, mime?: string): string | undefined {
  if (data === undefined || data === null || !/^[A-Za-z0-9+/=\r\n]+$/.test(data)) return undefined;
  const type = mime ?? (data.startsWith("iVBOR") ? "image/png" : data.startsWith("/9j/") ? "image/jpeg" : data.startsWith("R0lGOD") ? "image/gif" : data.startsWith("UklGR") ? "image/webp" : undefined);
  return type !== undefined && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type) ? `data:${type};base64,${data}` : undefined;
}

export function ImageView({ data, caption, mime, open }: { data?: string | null; caption: string; mime?: string; open: (source: string) => void }) {
  const source = mediaSource(data, mime);
  return source === undefined ? <p className="muted">{caption} · image data unavailable</p> : <button className="image-button" onClick={() => open(source)} aria-label={`View image: ${caption}`}><img loading="lazy" src={source} alt={caption} /></button>;
}

export function Blocks({ blocks, reasoning, tools, openImage }: { blocks: ContentBlock[]; reasoning: boolean; tools: boolean; openImage: (source: string) => void }) {
  return <>{blocks.map((block, index) => {
    switch (block.type) {
      case "text": return <div key={index} className="message-text">{block.text}</div>;
      case "thinking": return reasoning ? <details key={index}><summary>Reasoning</summary><div className="message-text muted">{block.thinking}</div></details> : null;
      case "redacted_thinking": return reasoning ? <p className="muted" key={index}>Reasoning redacted by provider</p> : null;
      case "tool_use": return tools ? <Inspect key={index} label={`Tool · ${block.name}`} value={block.input} /> : null;
      case "tool_result": return tools ? <details key={index}><summary>Tool result{block.is_error === true ? " · error" : ""}</summary>{typeof block.content === "string" ? <pre>{block.content}</pre> : <Blocks blocks={block.content} reasoning={reasoning} tools={tools} openImage={openImage} />}</details> : null;
      case "image": return <ImageView key={index} data={block.source.data} mime={block.source.media_type} caption="Inline image" open={openImage} />;
    }
  })}</>;
}

type ChoiceLists = Partial<Record<NonNullable<OperationField["choices"]>, string[]>>;
export function Field({ control, value, change, label, presentation, choices = {}, suggestions, secret = false }: {
  control: Control; value: unknown; change: (value: unknown) => void; label: string; presentation?: OperationField; choices?: ChoiceLists; suggestions?: string[]; secret?: boolean;
}) {
  const id = useId();
  switch (control.kind) {
    case "string": {
      const options = control.choices;
      const candidates = suggestions ?? (presentation?.choices === undefined ? undefined : choices[presentation.choices]);
      return <div className="field"><label htmlFor={id}>{label}</label>{secret ? <input id={id} type="password" autoComplete="new-password" value={typeof value === "string" ? value : ""} onChange={(event) => change(event.target.value)} /> : options !== undefined ? <select id={id} value={typeof value === "string" ? value : ""} onChange={(event) => change(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select>
        : presentation?.multiline === true ? <textarea id={id} rows={5} value={typeof value === "string" ? value : ""} onChange={(event) => change(event.target.value)} />
          : <><input id={id} list={candidates === undefined ? undefined : `${id}-choices`} value={typeof value === "string" ? value : ""} onChange={(event) => change(event.target.value)} />{candidates === undefined ? null : <datalist id={`${id}-choices`}>{candidates.map((candidate) => <option key={candidate} value={candidate} />)}</datalist>}</>}</div>;
    }
    case "integer": case "number": return <label className="field">{label}<input type="number" step={control.kind === "integer" ? 1 : "any"} min={control.minimum} max={control.maximum ?? Number.MAX_SAFE_INTEGER} value={typeof value === "number" && Number.isFinite(value) ? value : ""} onChange={(event) => change(event.target.valueAsNumber)} /></label>;
    case "boolean": return <label className="check"><input type="checkbox" checked={value === true} onChange={(event) => change(event.target.checked)} />{label}</label>;
    case "null": return <p className="muted">{label}: explicitly unset</p>;
    case "array": {
      const items: unknown[] = Array.isArray(value) ? value : [];
      return <fieldset><legend>{label}</legend>{items.map((item, index) => <div className="collection-row" key={index}><Field control={control.item} value={item} label={`${label} ${String(index + 1)}`} choices={choices} {...(suggestions === undefined ? {} : { suggestions })} secret={secret} change={(next) => change(items.map((old, position) => position === index ? next : old))} /><button type="button" aria-label={`Remove ${label} ${String(index + 1)}`} onClick={() => change(items.filter((_, position) => position !== index))}>Remove</button></div>)}<button type="button" onClick={() => change([...items, initialValue(control.item)])}>Add {label.toLowerCase()}</button></fieldset>;
    }
    case "union": {
      const index = Math.max(0, control.options.findIndex((option) => acceptsKind(option, value)));
      const selected = control.options[index];
      return <fieldset><label className="field">{label} format<select value={index} onChange={(event) => {
        const option = control.options[Number(event.target.value)]; if (option !== undefined) change(initialValue(option));
      }}>{control.options.map((option, position) => <option key={position} value={position}>{option.kind === "null" ? "Explicitly unset" : option.kind === "array" ? "Collection" : option.kind === "integer" ? "Whole number" : option.kind === "string" && option.choices !== undefined ? option.choices.join(" / ") : option.kind}</option>)}</select></label>{selected === undefined ? null : <Field control={selected} value={value} change={change} label={label} {...(presentation === undefined ? {} : { presentation })} choices={choices} {...(suggestions === undefined ? {} : { suggestions })} secret={secret} />}</fieldset>;
    }
    case "object": {
      const values = record(value);
      return <>{Object.entries(control.fields).map(([key, field]) => <Field key={key} label={key} control={field} value={values[key]} change={(next) => change({ ...values, [key]: next })} />)}</>;
    }
  }
}
