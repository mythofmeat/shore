import type { OpenImage } from "./media.ts";
import { COMPACTION_SUBAGENT } from "../memory/compaction/labels.ts";
import { useDisplay } from "./display_state.tsx";
import { useEffect, useState } from "react";
import type { OperationClient } from "./operations.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { CompactArgs } from "../protocol/CompactArgs.ts";
import type { ClearArgs } from "../protocol/ClearArgs.ts";
import type { CompactionReport } from "../protocol/CompactionReport.ts";
import type { SegmentsArgs } from "../protocol/SegmentsArgs.ts";
import type { SegmentsListing } from "../protocol/SegmentsListing.ts";
import type { SegmentInspection } from "../protocol/SegmentInspection.ts";
import type { LiveTurn } from "./workspace.ts";
import { operationPolicy } from "../operations/policy.ts";
import { Blocks, CancelWork, ImageView, Inspect, Modal } from "./components.tsx";

export function CompactionResult({ result }: { result: CompactionReport }) {
  const counts = <p>{String(result.message_count)} messages considered · {String(result.compacted_turns)} turns selected</p>;
  const retained = "retained_turns" in result ? <p>{String(result.retained_turns)} recent turns retained ({String(result.retained_count)} messages)</p> : null;
  const tools = "tools_called" in result ? <p className="muted">{String(result.tool_rounds)} tool rounds · {result.tools_called.join(", ") || "No tools called"}</p> : null;
  switch (result.status) {
    case "compacted": return <section aria-label="Compaction result"><h3>Context compacted</h3>{counts}{retained}<h4>Memory files written</h4>{result.memory_files_written.length === 0 ? <p>No memory files written.</p> : <ul>{result.memory_files_written.map((path) => <li key={path}>{path}</li>)}</ul>}{tools}<Inspect value={result} label="Complete compaction result" /></section>;
    case "rotated": return <section aria-label="Compaction result"><h3>{result.dry_run ? "Archive preview" : "Context archived"}</h3>{counts}{retained}<p>{String(result.archived_messages)} messages {result.dry_run ? "would be archived" : "archived"}. No memory files written.</p><Inspect value={result} label="Complete rotation result" /></section>;
    case "dry_run": return <section aria-label="Compaction result"><h3>Memory write preview</h3>{counts}{retained}<p>{String(result.would_write_files)} files would be written. The active context is unchanged.</p>{result.file_ops_preview.map((file, index) => <details key={`${file.path}.${String(index)}`}><summary>{file.path}</summary><pre>{file.content_preview}</pre></details>)}{tools}<Inspect value={result} label="Complete compaction preview" /></section>;
    case "paused": return <section aria-label="Compaction result"><h3>Compaction paused</h3>{counts}<p>The active context has not been archived. Resume the checkpoint, or restart to summarize again.</p><p>{result.reason}{result.detail === null ? "" : ` · ${result.detail}`}</p><p className="muted">Checkpoint: {result.checkpoint_id}{result.resume_at === null ? "" : ` · resume at ${result.resume_at}`}</p>{tools}<Inspect value={result} label="Complete paused compaction" /></section>;
    case "truncated": return <section aria-label="Compaction result"><h3>Compaction reached the token limit</h3>{counts}<p>The active context has not been archived. {String(result.truncated_turns)} turns were truncated; partial memory writes remain.</p><ul>{result.partial_writes.map((path) => <li key={path}>{path}</li>)}</ul>{tools}<Inspect value={result} label="Complete truncated compaction" /></section>;
  }
}

type ContextAction = { name: "compact"; args: CompactArgs } | { name: "clear"; args: ClearArgs };

export function Memory({ actions, operations, ready, character, thread, streams, close, changed, openImage }: {
  actions: OperationClient; operations: OperationDescriptor[]; ready: boolean; character: string; thread: string | null;
  streams: LiveTurn[]; close: () => void; changed: () => Promise<void>; openImage: OpenImage;
}) {
  const display = useDisplay();
  const [listing, setListing] = useState<SegmentsListing>();
  const [detail, setDetail] = useState<SegmentInspection>();
  const [index, setIndex] = useState("");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [keep, setKeep] = useState("");
  const [restart, setRestart] = useState(false);
  const [archiveNote, setArchiveNote] = useState("");
  const [exclude, setExclude] = useState(false);
  const [compaction, setCompaction] = useState<CompactionReport>();
  const [result, setResult] = useState<unknown>();
  const [pending, setPending] = useState<ContextAction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const disabled = busy || !ready || pending !== undefined;
  const compactOperation = operations.find((operation) => operation.name === "compact");
  const compactArgs = (): CompactArgs => ({ restart, ...(keep === "" ? {} : { keep_turns: Number(keep) }) });
  const refresh = async (remember = true) => {
    const value = await actions.run("segments", {}, { remember });
    if (!("segments" in value)) throw new Error("Expected a segment listing");
    setListing(value);
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const inspect = async (selected: number) => {
    const value = await actions.run("segments", { action: "show", index: selected });
    if (!("messages" in value)) throw new Error("Expected segment messages");
    setDetail(value); setIndex(String(selected)); setLabel(value.segment.label ?? ""); setNote(value.segment.note ?? "");
  };
  const edit = async (args: SegmentsArgs) => {
    const value = await actions.run("segments", args);
    if (!("action" in value)) throw new Error("Expected a segment change");
    setResult(value);
    setDetail((old) => old?.segment.index === value.segment.index ? { ...old, segment: value.segment } : old);
    await refresh(false);
  };
  const execute = async (action: ContextAction) => {
    await run(async () => {
      setResult(undefined); setCompaction(undefined);
      if (action.name === "compact") setCompaction(await actions.run("compact", action.args));
      else setResult(await actions.run("clear", action.args));
      await refresh(false); await changed();
    });
    setPending(undefined);
  };
  const request = (action: ContextAction) => {
    const operation = operations.find((item) => item.name === action.name);
    if (operation === undefined || operation.available === false) { setError("This action is unavailable for the selected conversation"); return; }
    if (operationPolicy(operation, action.args).confirmation === "none") void execute(action);
    else { setError(""); setPending(action); }
  };
  useEffect(() => {
    let current = true;
    if (ready) {
      setBusy(true);
      void actions.run("segments", {}, { remember: false }).then((value) => {
        if (!current) return;
        if (!("segments" in value)) throw new Error("Expected a segment listing");
        setListing(value); setError("");
      }).catch((failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (current) setBusy(false); });
    }
    return () => { current = false; };
  }, [actions, ready, character, thread]);
  return <Modal title="Memory & segments" close={close}><div className="memory-panel"><p className="muted">{character} / {thread ?? "home"} · active context and archived conversations</p>
    {!ready ? <p role="status">Reconnect to inspect or change memory. Unsaved fields remain while this dialog stays open.</p> : null}{busy ? <p role="status">Working on memory…</p> : null}{error === "" ? null : <p role="alert" className="error">{error}</p>}
    <CancelWork active={busy} ready={ready} cancel={() => actions.connection.cancel()} />
    <section aria-label="Active context controls"><h3>Active context</h3><p>Compaction summarizes older turns using the configured memory policy. A preview may make a provider request.</p>
      <form onSubmit={(event) => { event.preventDefault(); request({ name: "compact", args: compactArgs() }); }}><fieldset disabled={disabled || compactOperation?.available === false}>
        <legend>Compaction</legend><label className="field">Retain recent turns<input type="number" min="0" max="9007199254740991" step="1" value={keep} placeholder="Configured default" onChange={(event) => setKeep(event.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={restart} onChange={(event) => setRestart(event.target.checked)} />Restart paused work</label><p className="muted">Restart discards the checkpoint. Already written memory files remain.</p>
        <div className="actions"><button type="button" onClick={(event) => { if (event.currentTarget.form?.reportValidity() === true) request({ name: "compact", args: { ...compactArgs(), dry_run: true } }); }}>Preview compaction</button><button type="submit">{compaction?.status === "paused" && !restart ? "Resume compaction" : "Compact context"}</button></div>
      </fieldset></form>
      <form onSubmit={(event) => { event.preventDefault(); request({ name: "clear", args: { exclude, note: archiveNote } }); }}><fieldset disabled={disabled}><legend>Archive without summarizing</legend><label className="field">Archive note<textarea rows={2} value={archiveNote} onChange={(event) => setArchiveNote(event.target.value)} /></label><label className="check"><input type="checkbox" checked={exclude} onChange={(event) => setExclude(event.target.checked)} />Exclude new segment from history search</label><p className="muted">Archived messages stay inspectable. You can include the segment in search again later.</p><button type="submit">Clear active context</button></fieldset></form>
    </section>
    {pending === undefined ? null : <section className="confirmation" aria-label="Review context archive"><h3>Review context archive</h3><p>{character} / {thread ?? "home"}</p><p>{pending.name === "clear" ? "Archive the active conversation and start with an empty context, without summarizing it." : "Summarize and archive older turns according to the selected retention setting."}</p><pre>{JSON.stringify(pending.args, null, 2)}</pre><div className="actions"><button disabled={busy} onClick={() => setPending(undefined)}>Go back</button><button className="danger" disabled={busy || !ready} onClick={() => { void execute(pending); }}>Confirm archive</button></div></section>}
    {streams.filter((stream) => stream.subagent === COMPACTION_SUBAGENT && display.option("compaction") === "on").map((stream) => <details key={stream.key} open={busy}><summary>Compaction progress{stream.final ? " · finished" : ""}</summary>{stream.reasoning === "" || display.option("thinking") !== "on" ? null : <pre>{stream.reasoning}</pre>}<Blocks blocks={stream.blocks} reasoning tools openImage={openImage} />{stream.blocks.length === 0 ? <pre>{stream.text}</pre> : null}</details>)}
    {compaction === undefined ? null : <CompactionResult result={compaction} />}
    {result === undefined ? null : <section role="status"><h3>Memory action completed</h3><Inspect value={result} label="Complete memory action result" /></section>}
    <section aria-label="Archived segments"><div className="section-heading"><h3>Archived segments</h3><button disabled={disabled} onClick={() => { void run(refresh); }}>Refresh segments</button></div>
      {listing?.segments.length === 0 ? <p>No archived segments yet.</p> : <div className="table-scroll"><table><thead><tr><th>Segment</th><th>Archived / messages</th><th>Label</th><th>History search</th></tr></thead><tbody>{listing?.segments.map((segment) => <tr key={segment.index}><td><button disabled={disabled} onClick={() => { void run(() => inspect(segment.index)); }}>Inspect segment {String(segment.index)}</button></td><td>{segment.compacted_at}<br />{String(segment.message_count)} messages</td><td>{segment.label ?? "Unlabelled"}</td><td>{segment.excluded ? "Excluded" : "Included"}</td></tr>)}</tbody></table></div>}
      <form onSubmit={(event) => { event.preventDefault(); void run(() => inspect(Number(index))); }}><fieldset disabled={disabled} className="action-fields"><label className="field">Segment index<input required type="number" min="0" max="9007199254740991" step="1" value={index} onChange={(event) => setIndex(event.target.value)} /></label><button type="submit">Inspect segment</button></fieldset></form>
      <Inspect value={listing} label="Complete segment listing" />
    </section>
    {detail === undefined ? null : <section aria-label="Selected segment"><h3>Segment {String(detail.segment.index)}</h3><p>{detail.segment.first_message_at ?? "Unknown first message"} → {detail.segment.last_message_at ?? "Unknown last message"}</p><p>{detail.segment.excluded ? "Excluded from history search" : "Included in history search"}</p>
      <fieldset disabled={disabled}><legend>Segment metadata</legend><label className="field">Segment label<input value={label} onChange={(event) => setLabel(event.target.value)} /></label><div className="actions"><button onClick={() => { void run(() => edit({ action: "label", index: detail.segment.index, value: label })); }}>Save label</button><button onClick={() => { void run(async () => { await edit({ action: "label", index: detail.segment.index, value: null }); setLabel(""); }); }}>Clear label</button></div><label className="field">Segment note<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label><div className="actions"><button onClick={() => { void run(() => edit({ action: "note", index: detail.segment.index, value: note })); }}>Save note</button><button onClick={() => { void run(async () => { await edit({ action: "note", index: detail.segment.index, value: null }); setNote(""); }); }}>Clear note</button></div>
        <div className="actions"><button onClick={() => { void run(() => edit({ action: detail.segment.excluded ? "include" : "exclude", index: detail.segment.index })); }}>{detail.segment.excluded ? "Include in history search" : "Exclude from history search"}</button></div>
      </fieldset><details><summary>Memory revisions</summary><p>Before: {detail.segment.memory_before ?? "None"}</p><p>After: {detail.segment.memory_after ?? "None"}</p></details>
      <details><summary>Archived messages ({String(detail.messages.length)})</summary>{detail.messages.map((message, position) => <article className="message" key={`${message.msg_id}.${String(position)}`}><div className="message-heading"><strong>{message.role}</strong><time>{message.timestamp}</time></div>{message.content_blocks.length === 0 ? <p className="message-text">{message.content}</p> : <Blocks blocks={message.content_blocks} reasoning tools openImage={openImage} />}{message.images.map((image, imageIndex) => <ImageView key={imageIndex} data={image.data ?? null} caption={image.caption ?? image.path.split("/").at(-1) ?? "Archived image"} open={openImage} />)}</article>)}</details>
      <Inspect value={detail} label="Complete segment and messages" />
    </section>}
  </div></Modal>;
}
