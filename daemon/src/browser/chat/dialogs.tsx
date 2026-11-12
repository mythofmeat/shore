import { useEffect, useState, type ReactNode } from "react";
import type { ChromeSnapshot } from "../workspace.ts";
import { Dialog } from "../ui/controls.tsx";
import { toasts } from "../ui/toast.tsx";
import { conversation, errorText, replyMarks, streamReplies, workspace } from "../app/state.ts";
import { useReplyMarks } from "./marks.tsx";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import { compactionSummary, turnCount } from "./transcript.ts";

export type ConversationDialog = "compact" | "clear" | "reason" | "system";

export function useSubmit(close: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (work: () => Promise<string | undefined>) => {
    setBusy(true); setError("");
    void work().then((message) => { if (message !== undefined) toasts.show(message); close(); }).catch((failure: unknown) => setError(errorText(failure))).finally(() => setBusy(false));
  };
  return { busy, error, run };
}

export function Form({ title, close, submit, busy, error, action, danger = false, disabled = false, children }: {
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


function ReasonForm({ close, busy, error }: { close: () => void; busy: boolean; error: string }) {
  useReplyMarks();
  const [text, setText] = useState("");
  const [tags, setTags] = useState<readonly string[]>([]);
  useEffect(() => { void replyMarks.loadTags().catch(() => {}); }, []);
  const offered = replyMarks.tags();
  return <Form title="Regenerate with a reason" close={close} busy={busy} error={error} action="Regenerate" disabled={text.trim() === "" && tags.length === 0} submit={() => {
    close();
    void conversation.regenerate({ reason: text, tags }, streamReplies()).catch((failure: unknown) => toasts.show(errorText(failure), "error"));
  }}>
    <p className="form-text">The new response sees the earlier ones and why the shown one missed, and the shown one is kept as disliked with this reason. After it, the character doesn’t see any of this again.</p>
    {offered.length === 0 ? null : <div className="mark-tags" role="group" aria-label="Reasons">
      {offered.map((tag) => <button key={tag} type="button" className={`mark-tag ${tags.includes(tag) ? "on" : ""}`} aria-pressed={tags.includes(tag)} onClick={() => setTags(tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag])}>{tag}</button>)}
    </div>}
    <label className="field"><span>Why it missed {offered.length === 0 ? null : <span className="muted">(optional with a tag)</span>}</span><textarea className="input textarea" data-autofocus rows={4} value={text} onChange={(event) => setText(event.target.value)} /></label>
  </Form>;
}

async function resync(state: ChromeSnapshot): Promise<void> {
  await workspace.refreshThreads();
  if (state.thread !== null) await workspace.actions.run("switch_thread", { name: state.thread, resync: true });
}

function viewing(state: ChromeSnapshot): boolean {
  const now = workspace.getSnapshot();
  return now.character === state.character && now.thread === state.thread;
}

async function compactInBackground(state: ChromeSnapshot, label: string, work: () => Promise<string>): Promise<void> {
  try {
    const message = await work();
    toasts.show(viewing(state) ? message : `“${label}”: ${message}`);
  } catch (failure) { toasts.show(errorText(failure), "error"); }
}

export function ConversationDialogs({ dialog, state, close }: { dialog: ConversationDialog; state: ChromeSnapshot; close: () => void }) {
  const thread = state.threads.find((item) => item.id === state.thread);
  const { busy, error, run } = useSubmit(close);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState("");
  const [restart, setRestart] = useState(false);
  const label = thread === undefined ? state.thread ?? "" : threadLabel(thread);
  switch (dialog) {
    case "compact": return <Form title="Compact context" close={close} busy={busy} error={error} action="Compact" submit={() => {
      close();
      void compactInBackground(state, label, async () => {
        const report = await workspace.actions.run("compact", { ...(turns === "" ? {} : { keep_turns: Number(turns) }), ...(restart ? { restart: true } : {}) });
        if (viewing(state)) await resync(state);
        return compactionSummary(report);
      });
    }}>
      <p className="form-text">Summarizes older turns into memory so the thread fits the model’s context. Recent turns stay as they are. It runs in the background, so you can keep chatting in other threads, and closing this tab doesn’t stop it.</p>
      <label className="field"><span>Turns to keep <span className="muted">(optional)</span></span><input className="input" inputMode="numeric" placeholder="Configured default" value={turns} onChange={(event) => setTurns(event.target.value.replace(/\D/g, ""))} /></label>
      <label className="check"><input type="checkbox" checked={restart} onChange={(event) => setRestart(event.target.checked)} />Restart a paused compaction instead of resuming it</label>
    </Form>;
    case "clear": return <Form title="Clear context" close={close} busy={busy} error={error} action="Clear" danger submit={() => run(async () => {
      const result = await workspace.actions.run("clear", { ...(text.trim() === "" ? {} : { note: text.trim() }), ...(restart ? { exclude: true } : {}) });
      await resync(state); return `Cleared ${turnCount(result.segment.turn_count)} from the active context`;
    })}>
      <p className="form-text">Starts a fresh context. Earlier messages are kept as a segment you can open from the top of the thread.</p>
      <label className="field"><span>Note for the segment <span className="muted">(optional)</span></span><input className="input" value={text} onChange={(event) => setText(event.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={restart} onChange={(event) => setRestart(event.target.checked)} />Exclude the cleared messages from memory</label>
    </Form>;
    case "reason": return <ReasonForm close={close} busy={busy} error={error} />;
    case "system": return <Form title="Add system message" close={close} busy={busy} error={error} action="Add" disabled={text.trim() === ""} submit={() => run(async () => {
      await workspace.actions.run("inject_system", { text: text.trim() }); return undefined;
    })}>
      <label className="field"><span>Message</span><textarea className="input textarea" data-autofocus rows={4} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <p className="form-hint">Added to the thread as a system instruction without asking for a reply.</p>
    </Form>;
  }
}
