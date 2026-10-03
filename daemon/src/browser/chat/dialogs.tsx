import { useState, type ReactNode } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Dialog } from "../ui/controls.tsx";
import { toasts } from "../ui/toast.tsx";
import { conversation, errorText, streamReplies, workspace } from "../app/state.ts";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import { compactionSummary, compactionWatchSummary } from "./transcript.ts";

export type ConversationDialog = "rename" | "fork" | "compact" | "clear" | "guidance" | "system" | "archive";

function useSubmit(close: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (work: () => Promise<string | undefined>) => {
    setBusy(true); setError("");
    void work().then((message) => { if (message !== undefined) toasts.show(message); close(); }).catch((failure: unknown) => setError(errorText(failure))).finally(() => setBusy(false));
  };
  return { busy, error, run };
}

function Form({ title, close, submit, busy, error, action, danger = false, disabled = false, children }: {
  title: string; close: () => void; submit: () => void; busy: boolean; error: string; action: string; danger?: boolean; disabled?: boolean; children: ReactNode;
}) {
  return <Dialog title={title} close={close}>
    <form className="form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      {children}
      {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button type="submit" className={`button ${danger ? "danger" : "primary"}`} disabled={busy || disabled}>{busy ? "Working…" : action}</button></div>
    </form>
  </Dialog>;
}


async function resync(state: WorkspaceSnapshot): Promise<void> {
  await workspace.refreshNavigation();
  if (state.thread !== null) await workspace.actions.run("switch_thread", { name: state.thread, resync: true });
}

export function ConversationDialogs({ dialog, state, close }: { dialog: ConversationDialog; state: WorkspaceSnapshot; close: () => void }) {
  const thread = state.threads.find((item) => item.id === state.thread);
  const { busy, error, run } = useSubmit(close);
  const [text, setText] = useState(dialog === "rename" ? thread?.label ?? "" : "");
  const [name, setName] = useState("");
  const [turns, setTurns] = useState("");
  const [restart, setRestart] = useState(false);
  const [running, setRunning] = useState<"compact" | "watch" | "cancel">("compact");
  const label = thread === undefined ? state.thread ?? "" : threadLabel(thread);
  switch (dialog) {
    case "rename": return <Form title="Rename conversation" close={close} busy={busy} error={error} action="Save" submit={() => run(async () => {
      await workspace.actions.run("thread_label", { name: state.thread ?? "", label: text.trim() === "" ? null : text.trim() }); await workspace.refreshNavigation(); return undefined;
    })}>
      <label className="field"><span>Label</span><input className="input" autoFocus value={text} placeholder={state.thread ?? ""} onChange={(event) => setText(event.target.value)} /></label>
      <p className="form-hint">Leave empty to show the conversation’s name, “{state.thread}”.</p>
    </Form>;
    case "fork": return <Form title={`Fork “${label}”`} close={close} busy={busy} error={error} action="Fork" disabled={name.trim() === "" || (turns !== "" && !(Number(turns) >= 1))} submit={() => run(async () => {
      const result = await workspace.actions.run("fork_thread", { name: name.trim(), from: state.thread, ...(turns === "" ? {} : { turns: Number(turns) }) });
      await workspace.actions.run("switch_thread", { name: result.fork.thread, resync: true }); await workspace.refreshNavigation();
      return `Forked ${String(result.fork.turns)} turns into “${result.fork.thread}”`;
    })}>
      <label className="field"><span>New conversation name</span><input className="input" autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span>Copy only the last turns <span className="muted">(optional)</span></span><input className="input" inputMode="numeric" placeholder="All turns" value={turns} onChange={(event) => setTurns(event.target.value.replace(/\D/g, ""))} /></label>
    </Form>;
    case "compact": return <Form title="Compact context" close={close} busy={busy} error={error} action={{ compact: "Compact", watch: "Follow", cancel: "Stop" }[running]} danger={running === "cancel"} submit={() => run(async () => {
      if (running === "watch") return compactionWatchSummary(await workspace.actions.run("compact_watch", {}));
      if (running === "cancel") return compactionWatchSummary(await workspace.actions.run("compact_cancel", {}));
      const report = await workspace.actions.run("compact", { ...(turns === "" ? {} : { keep_turns: Number(turns) }), ...(restart ? { restart: true } : {}) });
      await resync(state); return compactionSummary(report);
    })}>
      <p className="form-text">Summarizes older turns into memory so the conversation fits the model’s context. Recent turns stay as they are. The compaction runs on the daemon, so closing this tab doesn’t stop it.</p>
      <label className="field"><span>What to do</span><select className="select" value={running} onChange={(event) => setRunning(event.target.value as "compact" | "watch" | "cancel")}>
        <option value="compact">Compact now</option><option value="watch">Follow the compaction already running</option><option value="cancel">Stop the running compaction</option>
      </select></label>
      {running === "compact" ? <>
        <label className="field"><span>Turns to keep <span className="muted">(optional)</span></span><input className="input" inputMode="numeric" placeholder="Configured default" value={turns} onChange={(event) => setTurns(event.target.value.replace(/\D/g, ""))} /></label>
        <label className="check"><input type="checkbox" checked={restart} onChange={(event) => setRestart(event.target.checked)} />Restart a paused compaction instead of resuming it</label>
      </> : <p className="form-hint">{running === "watch" ? "Shows the running compaction’s progress until it ends, whoever started it." : "The compaction pauses with its progress kept; compact again to resume it."}</p>}
    </Form>;
    case "clear": return <Form title="Clear context" close={close} busy={busy} error={error} action="Clear" danger submit={() => run(async () => {
      const result = await workspace.actions.run("clear", { ...(text.trim() === "" ? {} : { note: text.trim() }), ...(restart ? { exclude: true } : {}) });
      await resync(state); return `Cleared ${String(result.message_count)} messages from the active context`;
    })}>
      <p className="form-text">Starts a fresh context. Earlier messages are kept as a segment you can open from the top of the conversation.</p>
      <label className="field"><span>Note for the segment <span className="muted">(optional)</span></span><input className="input" value={text} onChange={(event) => setText(event.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={restart} onChange={(event) => setRestart(event.target.checked)} />Exclude the cleared messages from memory</label>
    </Form>;
    case "guidance": return <Form title="Regenerate with guidance" close={close} busy={busy} error={error} action="Regenerate" disabled={text.trim() === ""} submit={() => { close(); void conversation.regenerate(text, streamReplies()).catch((failure: unknown) => toasts.show(errorText(failure), "error")); }}>
      <label className="field"><span>Guidance for the new response</span><textarea className="input textarea" autoFocus rows={4} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <p className="form-hint">Used only for this regeneration; it isn’t saved to the conversation.</p>
    </Form>;
    case "system": return <Form title="Add a system message" close={close} busy={busy} error={error} action="Add" disabled={text.trim() === ""} submit={() => run(async () => {
      await workspace.actions.run("inject_system", { text: text.trim() }); return undefined;
    })}>
      <label className="field"><span>Message</span><textarea className="input textarea" autoFocus rows={4} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <p className="form-hint">Added to the conversation as a system instruction without asking for a reply.</p>
    </Form>;
    case "archive": return <Form title={`Archive “${label}”?`} close={close} busy={busy} error={error} action="Archive" danger submit={() => run(async () => {
      await workspace.actions.run("archive_thread", { name: state.thread ?? "" }); await workspace.refreshNavigation(); return `Archived “${label}”`;
    })}>
      <p className="form-text">The conversation is removed from the sidebar and Shore switches to the home conversation.</p>
    </Form>;
  }
}
