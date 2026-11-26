import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThreadPinStatus } from "../../protocol/ThreadPinStatus.ts";
import type { ThreadPromptView } from "../../protocol/ThreadPromptView.ts";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import { errorText, workspace } from "../app/state.ts";
import { Dialog, Spinner } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";

const SHOWN_FILES = 100;

export function threadPinList(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

export function pinSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const tenths = Math.floor(bytes * 10 / 1024);
  return tenths % 10 === 0 ? `${String(tenths / 10)} KB` : `${(tenths / 10).toFixed(1)} KB`;
}

const OVER = "past what a thread’s pins can take together";

function pinState(pin: ThreadPinStatus): { text: string; tone: "" | "warn" | "danger" | "quiet" } {
  if (pin.shown === "nothing") {
    return pin.pin.startsWith("!") ? { text: "runs with the next message", tone: "quiet" } : { text: "empty, or not in the workspace", tone: "danger" };
  }
  const size = pinSize(pin.bytes);
  if (pin.shown === "cut") return { text: `${size} · cut: ${OVER}`, tone: "warn" };
  if (pin.shown === "left_out") return { text: `${size} · left out: ${OVER}`, tone: "danger" };
  return pin.changed ? { text: `${size} · changed since; the model sees it after a refresh`, tone: "warn" } : { text: size, tone: "" };
}

export function SavedPins({ pins }: { pins: readonly ThreadPinStatus[] }) {
  return <ul className="pin-status" aria-label="Saved pins">
    {pins.map((pin) => {
      const state = pinState(pin);
      return <li key={pin.pin} className="pin-status-row"><span className="pin-path mono">{pin.pin}</span><span className={`pin-state ${state.tone}`}>{state.text}</span></li>;
    })}
  </ul>;
}

function FilePicker({ pinned, pick, close }: { pinned: readonly string[]; pick: (path: string) => void; close: () => void }) {
  const [files, setFiles] = useState<readonly string[]>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true;
    workspace.actions.run("workspace_files", {})
      .then((listing) => { if (alive) setFiles(listing.files); })
      .catch((failure: unknown) => { if (alive) setError(errorText(failure)); });
    return () => { alive = false; };
  }, []);
  const needle = query.trim().toLowerCase();
  const matching = useMemo(() => (files ?? []).filter((file) => file.toLowerCase().includes(needle)), [files, needle]);
  return <Dialog title="Pin a file" close={close} wide>
    <p className="form-text">Hidden files, pictures and videos aren’t listed. Any path, [[link]] or !command can still be typed into the list.</p>
    <div className="picker-tools">
      <label className="sidebar-search picker-search"><Icon name="search" size={16} /><input type="search" data-autofocus aria-label="Search workspace files" placeholder="Search workspace files" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>
    {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
    <div className="picker-list" role="listbox" aria-label="Workspace files">
      {files === undefined ? error === "" ? <div className="picker-empty"><Spinner label="Loading files" /></div> : null
        : matching.length === 0 ? <p className="picker-empty">No files match.</p>
        : matching.slice(0, SHOWN_FILES).map((file) => {
          const on = pinned.includes(file);
          return <button key={file} type="button" role="option" aria-selected={on} className={`picker-item ${on ? "on" : ""}`} disabled={on} onClick={() => { pick(file); close(); }}>
            <span className="picker-name mono">{file}</span>
            {on ? <Icon name="check" size={16} className="picker-check" /> : null}
          </button>;
        })}
      {matching.length > SHOWN_FILES ? <p className="picker-empty">{matching.length - SHOWN_FILES} more; type to narrow the list.</p> : null}
    </div>
  </Dialog>;
}

export function PinsField({ value, change, note, hint, children }: { value: string; change: (value: string) => void; note: string; hint?: string; children?: ReactNode }) {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const pinned = threadPinList(value);
  useEffect(() => {
    const field = box.current;
    if (picked === 0 || field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    field.scrollTop = field.scrollHeight;
  }, [picked]);
  return <>
    <label className="field"><span>Pinned in the prompt <span className="muted">({note})</span></span><textarea ref={box} className="input textarea mono" rows={3} wrap="off" placeholder={"stories/lighthouse.md\n!git log --oneline -5\n[[lighthouse/]]"} value={value} onChange={(event) => change(event.target.value)} /></label>
    {hint === undefined ? null : <p className="form-hint">{hint}</p>}
    <div className="pin-actions">
      <button type="button" className="button" onClick={() => setPicking(true)}>Add a file…</button>
      {children}
    </div>
    {picking ? <FilePicker pinned={pinned} close={() => setPicking(false)} pick={(file) => { change([...pinned, file].join("\n")); setPicked((count) => count + 1); }} /> : null}
  </>;
}

const OPEN_PARTS = new Set(["thread", "thread_pins"]);

export function ThreadPromptDialog({ thread, label, view, replying, refresh, close }: {
  thread: ThreadView; label: string; view: ThreadPromptView; replying: boolean; refresh: () => Promise<void>; close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refreshNow = () => {
    setBusy(true); setError("");
    void refresh().catch((failure: unknown) => setError(errorText(failure))).finally(() => setBusy(false));
  };
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  return <Dialog title={`Prompt for “${label}”`} close={close} wide footer={<div className="prompt-refresh">
    <p className="form-hint">The prompt refreshes on its own {thread.home ? "when this thread compacts" : "after a long pause here, and when this thread compacts"}. Refreshing now reads the pinned files and runs the pinned commands again, and the next message misses the prompt cache.</p>
    {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="button" disabled={busy || replying} onClick={refreshNow}>{busy ? "Refreshing…" : "Refresh now"}</button>
  </div>}>
    <p className="form-text">The system prompt this thread’s next message sends. The notes Shore puts on messages and the tool descriptions aren’t part of it; Settings › Traces shows whole requests while call logging is on.</p>
    {view.pins.length === 0 ? null : <SavedPins pins={view.pins} />}
    {view.parts.length === 0 ? <p className="form-text">This thread has no system prompt.</p> : view.parts.map((part) =>
      <details key={part.label} className="disclosure payload prompt-part" open={OPEN_PARTS.has(part.label)}>
        <summary><span className="mono">{part.label}</span> <span className="muted">{pinSize(bytes(part.text))}</span>{part.changed ? <span className="tag">changed since; the model sees it after a refresh</span> : null}</summary>
        <pre className="readout">{part.text}</pre>
      </details>)}
  </Dialog>;
}

export function pinnedToast(pins: readonly string[]): string {
  if (pins.length === 0) return "Pins cleared";
  const named = pins.slice(0, 3).join(", ");
  return pins.length > 3 ? `Pinned ${named} and ${String(pins.length - 3)} more` : `Pinned ${named}`;
}
