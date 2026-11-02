import { useState } from "react";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { workspace } from "../app/state.ts";
import { threadFileList } from "../sidebar/dialogs.tsx";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import type { FolderDialogRequest, ThreadDialogRequest } from "../app/intents.ts";
import { threadSections } from "../sidebar/order.ts";
import { moveThreadTo } from "./actions.ts";
import { Form, useSubmit } from "./dialogs.tsx";
import { ModelPicker, shortModel } from "./models.tsx";

async function saveThreadSettings(thread: ThreadView, values: { label: string; purpose: string; files: string[]; locked: boolean; model: string | null; compaction: boolean }): Promise<void> {
  const name = thread.id;
  const label = values.label.trim();
  const purpose = values.purpose.trim();
  if (values.files.join("\n") !== (thread.files ?? []).join("\n")) await workspace.actions.run("thread_files", { name, files: values.files });
  if (label !== (thread.label ?? "")) await workspace.actions.run("thread_label", { name, label: label === "" ? null : label });
  if (purpose !== (thread.purpose ?? "")) await workspace.actions.run("thread_purpose", { name, purpose: purpose === "" ? null : purpose });
  if (values.locked !== (thread.locked === true)) await workspace.actions.run("thread_lock", { name, locked: values.locked });
  if (values.compaction !== thread.compaction) await workspace.actions.run("thread_compaction", { name, compaction: values.compaction });
  if (values.model !== (thread.chat_model ?? null)) await workspace.actions.run("thread_model", { name, model: values.model });
  await workspace.refreshThreads();
}

function ThreadSettingsDialog({ state, thread, close }: { state: WorkspaceSnapshot; thread: ThreadView; close: () => void }) {
  const { busy, error, run } = useSubmit(close);
  const [label, setLabel] = useState(thread.label ?? "");
  const [purpose, setPurpose] = useState(thread.purpose ?? "");
  const [files, setFiles] = useState((thread.files ?? []).join("\n"));
  const [locked, setLocked] = useState(thread.locked === true);
  const [model, setModel] = useState<string | null>(thread.chat_model ?? null);
  const [compaction, setCompaction] = useState(thread.compaction);
  const [picking, setPicking] = useState(false);
  const character = state.character ?? "The character";
  return <Form title="Thread settings" close={close} busy={busy} error={error} action="Save" submit={() => run(async () => {
    await saveThreadSettings(thread, { label, purpose, files: threadFileList(files), locked, model, compaction });
    return undefined;
  })}>
    <label className="field"><span>Label</span><input className="input" data-autofocus value={label} placeholder={thread.id} onChange={(event) => setLabel(event.target.value)} /></label>
    <p className="form-hint">Leave empty to show the thread’s name, “{thread.id}”.</p>
    <label className="field"><span>Purpose <span className="muted">(optional)</span></span><textarea className="input textarea" rows={2} value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
    <label className="field"><span>Files in the prompt <span className="muted">(optional)</span></span><textarea className="input textarea mono" rows={3} placeholder={"stories/lighthouse.md\n[[lighthouse/]]"} value={files} onChange={(event) => setFiles(event.target.value)} /></label>
    <p className="form-hint">The character sees the purpose and these workspace files in this thread’s prompt. One path or [[link]] per line.</p>
    <div className="field">
      <span>Model</span>
      <button type="button" className="button thread-model" aria-label={`Model: ${model ?? `${character}’s default`}. Change model`} onClick={() => setPicking(true)}><span className="mono">{model === null ? `${character}’s default` : shortModel(model)}</span></button>
    </div>
    {thread.heartbeat === true ? null : <label className="field"><span>When it gets long</span><select className="select" value={compaction ? "compact" : "trim"} onChange={(event) => setCompaction(event.target.value === "compact")}><option value="trim">Trim its oldest turns into the archive</option><option value="compact">Compact it into memory, as the home thread does</option></select></label>}
    <label className="check"><input type="checkbox" checked={locked} onChange={(event) => setLocked(event.target.checked)} />Lock the label, purpose and files</label>
    <p className="form-hint">Only you can change a locked thread’s label, purpose and files. {character} can still edit the files themselves.</p>
    {picking ? <ModelPicker state={state} close={() => setPicking(false)} target={{ kind: "thread", id: thread.id }} scopes={false} current={model} pick={setModel} /> : null}
  </Form>;
}

function ForkDialog({ thread, close }: { thread: ThreadView; close: () => void }) {
  const { busy, error, run } = useSubmit(close);
  const [name, setName] = useState("");
  const [turns, setTurns] = useState("");
  return <Form title={`Fork “${threadLabel(thread)}”`} close={close} busy={busy} error={error} action="Fork" disabled={name.trim() === "" || (turns !== "" && !(Number(turns) >= 1))} submit={() => run(async () => {
    const result = await workspace.actions.run("fork_thread", { name: name.trim(), from: thread.id, ...(turns === "" ? {} : { turns: Number(turns) }) });
    await workspace.openThread(result.fork.thread);
    return `Forked ${String(result.fork.turns)} turns into “${result.fork.thread}”`;
  })}>
    <label className="field"><span>New thread name</span><input className="input" data-autofocus value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="field"><span>Copy only the last turns <span className="muted">(optional)</span></span><input className="input" inputMode="numeric" placeholder="All turns" value={turns} onChange={(event) => setTurns(event.target.value.replace(/\D/g, ""))} /></label>
  </Form>;
}

function ArchiveDialog({ state, thread, close }: { state: WorkspaceSnapshot; thread: ThreadView; close: () => void }) {
  const { busy, error, run } = useSubmit(close);
  const label = threadLabel(thread);
  return <Form title={`Archive “${label}”?`} close={close} busy={busy} error={error} action="Archive" danger submit={() => run(async () => {
    await workspace.actions.run("archive_thread", { name: thread.id });
    await workspace.refreshThreads();
    return `Archived “${label}”`;
  })}>
    <p className="form-text">{thread.id === state.thread ? "The thread is removed from the sidebar and Shore switches to the home thread." : "The thread is removed from the sidebar."} Its messages stay searchable.</p>
  </Form>;
}

function MoveToFolderDialog({ state, thread, close }: { state: WorkspaceSnapshot; thread: ThreadView; close: () => void }) {
  const { busy, error, run } = useSubmit(close);
  const [choice, setChoice] = useState(thread.folder ?? "");
  const [name, setName] = useState("");
  const fresh = choice === NEW_FOLDER;
  const firstLoose = threadSections(state.threads, state.folders).loose.find((item) => item.id !== thread.id)?.id;
  return <Form title={`Move “${threadLabel(thread)}”`} close={close} busy={busy} error={error} action="Move" disabled={fresh && name.trim() === ""} submit={() => run(async () => {
    if (fresh) workspace.applyThreadListing(await workspace.actions.run("thread_folder_create", { name: name.trim() }));
    const folder = fresh ? name.trim() : choice;
    await moveThreadTo(thread.id, { folder, ...(folder === "" && firstLoose !== undefined ? { before: firstLoose } : {}) });
    return undefined;
  })}>
    <label className="field"><span>Folder</span><select className="select" data-autofocus value={choice} onChange={(event) => setChoice(event.target.value)}>
      <option value="">No folder</option>
      {state.folders.map((folder) => <option key={folder.name} value={folder.name}>{folder.name}</option>)}
      <option value={NEW_FOLDER}>New folder…</option>
    </select></label>
    {fresh ? <label className="field"><span>New folder name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label> : null}
  </Form>;
}

const NEW_FOLDER = "\u0000new";

export function FolderDialogs({ request, close }: { request: FolderDialogRequest; close: () => void }) {
  const { busy, error, run } = useSubmit(close);
  const [name, setName] = useState(request.kind === "rename" ? request.folder : "");
  const apply = async (work: () => ReturnType<typeof workspace.actions.run<"thread_folder_create">>) => { workspace.applyThreadListing(await work()); return undefined; };
  switch (request.kind) {
    case "new": return <Form title="New folder" close={close} busy={busy} error={error} action="Create" disabled={name.trim() === ""} submit={() => run(() => apply(() => workspace.actions.run("thread_folder_create", { name: name.trim() })))}>
      <label className="field"><span>Name</span><input className="input" data-autofocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p className="form-hint">Drag threads onto the folder, or use Move to folder… in a thread’s menu.</p>
    </Form>;
    case "rename": return <Form title={`Rename “${request.folder}”`} close={close} busy={busy} error={error} action="Rename" disabled={name.trim() === ""} submit={() => run(() => apply(() => workspace.actions.run("thread_folder_rename", { name: request.folder, to: name.trim() })))}>
      <label className="field"><span>Name</span><input className="input" data-autofocus value={name} onChange={(event) => setName(event.target.value)} /></label>
    </Form>;
    case "delete": return <Form title={`Delete “${request.folder}”?`} close={close} busy={busy} error={error} action="Delete" danger submit={() => run(() => apply(() => workspace.actions.run("thread_folder_delete", { name: request.folder })))}>
      <p className="form-text">Its threads go back to the list outside folders. None of them is archived.</p>
    </Form>;
  }
}

export function ThreadDialogs({ state, request, close }: { state: WorkspaceSnapshot; request: ThreadDialogRequest; close: () => void }) {
  const thread = state.threads.find((item) => item.id === request.thread);
  if (thread === undefined) return null;
  switch (request.kind) {
    case "settings": return <ThreadSettingsDialog state={state} thread={thread} close={close} />;
    case "fork": return <ForkDialog thread={thread} close={close} />;
    case "archive": return <ArchiveDialog state={state} thread={thread} close={close} />;
    case "move": return <MoveToFolderDialog state={state} thread={thread} close={close} />;
  }
}
