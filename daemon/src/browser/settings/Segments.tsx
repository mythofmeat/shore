import { useEffect, useState } from "react";
import type { SegmentSummary } from "../../protocol/SegmentSummary.ts";
import type { SegmentInspection } from "../../protocol/SegmentInspection.ts";
import type { ChromeSnapshot } from "../workspace.ts";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import { Markdown } from "../markdown.tsx";
import { Spinner } from "../ui/controls.tsx";
import { errorText, perform, workspace } from "../app/state.ts";
import { navigate } from "../app/route.ts";
import { SettingsSection } from "./layout.tsx";
import { turnCount } from "../chat/transcript.ts";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import { formatTime, Loading, NeedsCharacter, useAction } from "./shared.tsx";
import { Form, useSubmit } from "../chat/dialogs.tsx";

function TextEdit({ label, value, save, busy }: { label: string; value: string | null; save: (value: string) => void; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? "");
  if (!editing) return <button type="button" className="button ghost" onClick={() => { setText(value ?? ""); setEditing(true); }}>{value === null ? `Add ${label.toLowerCase()}` : `Edit ${label.toLowerCase()}`}</button>;
  return <form className="inline-form" onSubmit={(event) => { event.preventDefault(); save(text); setEditing(false); }}>
    <input className="input" aria-label={label} autoFocus value={text} onChange={(event) => setText(event.target.value)} />
    <button type="button" className="button" onClick={() => setEditing(false)}>Cancel</button><button type="submit" className="button primary" disabled={busy}>Save</button>
  </form>;
}

interface Listed { thread: string; name: string; segment: SegmentSummary }

const ALL_THREADS = "";

function newestFirst(a: Listed, b: Listed): number {
  const ended = (listed: Listed) => listed.segment.last_message_at ?? listed.segment.compacted_at;
  return ended(b).localeCompare(ended(a)) || b.segment.index - a.segment.index;
}

function useSegments(state: ChromeSnapshot, threads: readonly Pick<ThreadView, "id" | "label">[]) {
  const [listed, setListed] = useState<Listed[]>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState({});
  const wanted = JSON.stringify(threads.map((thread) => [thread.id, threadLabel(thread)]));
  useEffect(() => {
    if (state.character === null || state.status !== "ready") return;
    let alive = true;
    void Promise.all((JSON.parse(wanted) as [string, string][]).map(async ([thread, name]) => {
      const result = await workspace.actions.run("segments", { thread });
      return "segments" in result ? result.segments.map((segment) => ({ thread, name, segment })) : [];
    })).then(
      (lists) => () => { setListed(lists.flat().sort(newestFirst)); setError(""); },
      (failure: unknown) => () => { setError(errorText(failure)); },
    ).then((settle) => { if (alive) settle(); });
    return () => { alive = false; };
  }, [state.status, state.character, wanted, version]);
  return { listed, error, refresh: () => { setVersion({}); } };
}

function Segment({ listed: { thread, name, segment }, named, open: openInChat, changed }: { listed: Listed; named: boolean; open: () => Promise<void>; changed: () => void }) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<SegmentInspection>();
  const { busy, run } = useAction();
  const writing = useAction();
  const [replacing, setReplacing] = useState(false);
  const replace = useSubmit(() => setReplacing(false));
  const autoLabel = async () => {
    await workspace.actions.run("segments", { action: "label", index: segment.index, thread, auto: true, replace: segment.label !== null });
    changed();
    return undefined;
  };
  const act = (action: "exclude" | "include" | "label" | "note", value?: string) => void run(async () => {
    await workspace.actions.run("segments", { action, index: segment.index, thread, ...(value === undefined ? {} : { value }) });
    changed();
    return action === "exclude" ? `Segment ${String(segment.index)} excluded from chat logs` : action === "include" ? `Segment ${String(segment.index)} included in chat logs` : undefined;
  });
  const show = () => {
    setOpen(!open);
    if (!open && inspection === undefined) void run(async () => {
      const result = await workspace.actions.run("segments", { action: "show", index: segment.index, thread });
      if ("messages" in result) setInspection(result);
      return undefined;
    });
  };
  return <div className={`segment ${segment.excluded ? "excluded" : ""}`}>
    <div className="segment-head">
      <div>
        <div className="setting-label">{segment.label ?? `Segment ${String(segment.index)}`}{segment.excluded ? <span className="tag muted-tag">excluded</span> : null}</div>
        <div className="setting-description">{named ? `${name} · ` : ""}{turnCount(segment.turn_count)} · {formatTime(segment.first_message_at)} – {formatTime(segment.last_message_at)} · compacted {formatTime(segment.compacted_at)}</div>
        {segment.note === null ? null : <div className="setting-description">Note: {segment.note}</div>}
      </div>
    </div>
    <div className="actions-row tight">
      <button type="button" className="button" aria-expanded={open} onClick={show}>{open ? "Hide" : "View"}</button>
      <button type="button" className="button ghost" onClick={() => perform(async () => { await openInChat(); navigate({ view: "chat" }); })}>Open in chat</button>
      <button type="button" className="button ghost" disabled={busy} onClick={() => act(segment.excluded ? "include" : "exclude")}>{segment.excluded ? "Include in chat logs" : "Exclude from chat logs"}</button>
      <TextEdit label="Label" value={segment.label} busy={busy} save={(value) => act("label", value)} />
      <button type="button" className="button ghost" disabled={writing.busy} onClick={() => { if (segment.label === null) void writing.run(autoLabel); else setReplacing(true); }}>{writing.busy ? "Labelling…" : "Auto-label"}</button>
      <TextEdit label="Note" value={segment.note} busy={busy} save={(value) => act("note", value)} />
    </div>
    {replacing ? <Form title="Replace this label?" close={() => setReplacing(false)} action="Replace" busy={replace.busy} error={replace.error} submit={() => replace.run(autoLabel)}>
      <p className="form-text">The chat model will read the segment and write a new label in place of “{segment.label}”.</p>
    </Form> : null}
    {open ? <div className="segment-body">
      {segment.memory_after === null ? null : <><div className="tool-label">Memory after this segment</div><div className="readout prose-readout"><Markdown text={segment.memory_after} /></div></>}
      {inspection === undefined ? <Spinner label="Loading messages" /> : <div className="segment-messages">{inspection.messages.map((message) => <div key={message.msg_id} className="segment-message"><span className="setting-label">{message.role === "user" ? "You" : message.role === "assistant" ? inspection.character : "System"}</span><Markdown text={message.content} /></div>)}</div>}
    </div> : null}
  </div>;
}

export function SegmentsPage({ state }: { state: ChromeSnapshot }) {
  const [picked, setPicked] = useState<string>();
  const current = state.thread ?? "main";
  const shown = picked ?? current;
  const { listed, error, refresh } = useSegments(state, shown === ALL_THREADS ? state.threads : [state.threads.find((thread) => thread.id === shown) ?? { id: shown }]);
  if (state.character === null) return <NeedsCharacter />;
  const openIn = (thread: string, index: number) => async () => {
    if (thread !== current) await workspace.openThread(thread);
    await workspace.openSegment(index);
  };
  const picker = <select className="select" aria-label="Thread" value={shown} onChange={(event) => setPicked(event.target.value)}>
    <option value={ALL_THREADS}>All threads</option>
    {state.threads.map((thread) => <option key={thread.id} value={thread.id}>{threadLabel(thread)}</option>)}
  </select>;
  return <>
    <p className="settings-description">When a thread is compacted, its older turns become a segment.</p>
    <SettingsSection title={`Segments in ${state.character}`} actions={picker}>
      <Loading error={error} ready={listed !== undefined}>
        {listed?.length === 0 ? <p className="settings-empty">No segments yet. They appear when a thread is compacted.</p> : null}
        <div className="segment-list">{listed?.map((item) => <Segment key={`${item.thread}/${String(item.segment.index)}`} listed={item} named={shown === ALL_THREADS} open={openIn(item.thread, item.segment.index)} changed={refresh} />)}</div>
      </Loading>
    </SettingsSection>
  </>;
}
