import { useState } from "react";
import type { SegmentSummary } from "../../protocol/SegmentSummary.ts";
import type { SegmentInspection } from "../../protocol/SegmentInspection.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Markdown } from "../markdown.tsx";
import { Spinner } from "../ui/controls.tsx";
import { workspace } from "../app/state.ts";
import { SettingsSection } from "./layout.tsx";
import { formatTime, Loading, NeedsCharacter, useAction, useOperation } from "./shared.tsx";

function TextEdit({ label, value, save, busy }: { label: string; value: string | null; save: (value: string) => void; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? "");
  if (!editing) return <button type="button" className="button ghost" onClick={() => { setText(value ?? ""); setEditing(true); }}>{value === null ? `Add ${label.toLowerCase()}` : `Edit ${label.toLowerCase()}`}</button>;
  return <form className="inline-form" onSubmit={(event) => { event.preventDefault(); save(text); setEditing(false); }}>
    <input className="input" aria-label={label} autoFocus value={text} onChange={(event) => setText(event.target.value)} />
    <button type="button" className="button" onClick={() => setEditing(false)}>Cancel</button><button type="submit" className="button primary" disabled={busy}>Save</button>
  </form>;
}

function Segment({ segment, changed }: { segment: SegmentSummary; changed: () => void }) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<SegmentInspection>();
  const { busy, run } = useAction();
  const act = (action: "exclude" | "include" | "label" | "note", value?: string) => void run(async () => {
    await workspace.actions.run("segments", { action, index: segment.index, ...(value === undefined ? {} : { value }) });
    changed();
    return action === "exclude" ? `Segment ${String(segment.index)} excluded from memory` : action === "include" ? `Segment ${String(segment.index)} included in memory` : undefined;
  });
  const show = () => {
    setOpen(!open);
    if (!open && inspection === undefined) void run(async () => {
      const result = await workspace.actions.run("segments", { action: "show", index: segment.index });
      if ("messages" in result) setInspection(result);
      return undefined;
    });
  };
  return <div className={`segment ${segment.excluded ? "excluded" : ""}`}>
    <div className="segment-head">
      <div>
        <div className="setting-label">{segment.label ?? `Segment ${String(segment.index)}`}{segment.excluded ? <span className="tag muted-tag">excluded</span> : null}</div>
        <div className="setting-description">{segment.message_count} messages · {formatTime(segment.first_message_at)} – {formatTime(segment.last_message_at)} · compacted {formatTime(segment.compacted_at)}</div>
        {segment.note === null ? null : <div className="setting-description">Note: {segment.note}</div>}
      </div>
    </div>
    <div className="actions-row tight">
      <button type="button" className="button" aria-expanded={open} onClick={show}>{open ? "Hide" : "View"}</button>
      <button type="button" className="button ghost" disabled={busy} onClick={() => act(segment.excluded ? "include" : "exclude")}>{segment.excluded ? "Include in memory" : "Exclude from memory"}</button>
      <TextEdit label="Label" value={segment.label} busy={busy} save={(value) => act("label", value)} />
      <TextEdit label="Note" value={segment.note} busy={busy} save={(value) => act("note", value)} />
    </div>
    {open ? <div className="segment-body">
      {segment.memory_after === null ? null : <><div className="tool-label">Memory after this segment</div><div className="readout prose-readout"><Markdown text={segment.memory_after} /></div></>}
      {inspection === undefined ? <Spinner label="Loading messages" /> : <div className="segment-messages">{inspection.messages.map((message) => <div key={message.msg_id} className="segment-message"><span className="setting-label">{message.role === "user" ? "You" : message.role === "assistant" ? inspection.character : "System"}</span><Markdown text={message.content} /></div>)}</div>}
    </div> : null}
  </div>;
}

export function MemoryPage({ state }: { state: WorkspaceSnapshot }) {
  const listing = useOperation(state, "segments", {}, [state.thread], state.character !== null);
  if (state.character === null) return <NeedsCharacter />;
  const data = listing.data !== undefined && "segments" in listing.data ? listing.data : undefined;
  return <>
    <p className="settings-description">When a conversation is compacted or cleared, the older messages become a segment. Excluded segments stay stored but aren’t used for memory.</p>
    <SettingsSection title={`Segments in ${state.character} / ${state.thread ?? "main"}`}>
      <Loading error={listing.error} ready={data !== undefined}>
        {data?.segments.length === 0 ? <p className="settings-empty">No segments yet. They appear after the conversation is compacted or cleared.</p> : null}
        <div className="segment-list">{data?.segments.map((segment) => <Segment key={segment.index} segment={segment} changed={listing.refresh} />)}</div>
      </Loading>
    </SettingsSection>
  </>;
}
