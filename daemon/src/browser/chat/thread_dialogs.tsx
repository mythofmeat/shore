import { useState } from "react";
import type { ThreadView } from "../../protocol/ThreadView.ts";
import type { ChromeSnapshot } from "../workspace.ts";
import { conversation, workspace } from "../app/state.ts";
import { useOperation, type OperationState } from "../settings/shared.tsx";
import { PinsField, pinnedToast, SavedPins, ThreadPromptDialog, threadPinList } from "./thread_prompt.tsx";
import { WhenLongField } from "../sidebar/dialogs.tsx";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import { namedThread } from "../sidebar/thread_names.ts";
import type { FolderDialogRequest, ThreadDialogRequest } from "../app/intents.ts";
import { threadSections } from "../sidebar/order.ts";
import { moveThreadTo } from "./actions.ts";
import { Form, useSubmit } from "./dialogs.tsx";
import { ModelPicker, shortModel } from "./models.tsx";

async function saveThreadSettings(thread: ThreadView, values: { label: string; purpose: string; pins: string[]; locked: boolean; model: string | null; compaction: boolean }): Promise<string | undefined> {
  const name = thread.id;
  const label = values.label.trim();
  const purpose = values.purpose.trim();
  const pinned = values.pins.join("\n") === (thread.pins ?? []).join("\n") ? undefined : await workspace.actions.run("thread_pins", { name, pins: values.pins });
  if (label !== (thread.label ?? "")) await workspace.actions.run("thread_label", { name, label: label === "" ? null : label });
  if (purpose !== (thread.purpose ?? "")) await workspace.actions.run("thread_purpose", { name, purpose: purpose === "" ? null : purpose });
  if (values.locked !== (thread.locked === true)) await workspace.actions.run("thread_lock", { name, locked: values.locked });
  if (values.compaction !== thread.compaction) await workspace.actions.run("thread_compaction", { name, compaction: values.compaction });
  if (values.model !== (thread.chat_model ?? null)) await workspace.actions.run("thread_model", { name, model: values.model });
  await workspace.refreshThreads();
  const stored = pinned?.threads.find((item) => item.id === name);
  return stored === undefined ? undefined : pinnedToast(stored.pins ?? []);
}

function SavedPinsField({ prompt }: { prompt: OperationState<"thread_prompt"> }) {
  if (prompt.error !== "") return <p className="form-hint">The saved pins couldn’t be checked: {prompt.error}</p>;
  if (prompt.data === undefined) return <p className="form-hint">Checking the saved pins…</p>;
  if (prompt.data.pins.length === 0) return null;
  return <div className="field"><span>Saved pins, as the next message sends them</span><SavedPins pins={prompt.data.pins} /></div>;
}

function ThreadSettingsDialog({ state, thread, close }: { state: ChromeSnapshot; thread: ThreadView; close: () => void }) {
  const { busy, error, run } = useSubmit(close);
  const [label, setLabel] = useState(thread.label ?? "");
  const [purpose, setPurpose] = useState(thread.purpose ?? "");
  const [pins, setPins] = useState((thread.pins ?? []).join("\n"));
  const [locked, setLocked] = useState(thread.locked === true);
  const [model, setModel] = useState<string | null>(thread.chat_model ?? null);
  const [compaction, setCompaction] = useState(thread.compaction);
  const [picking, setPicking] = useState(false);
  const [viewing, setViewing] = useState(false);
  const prompted = thread.wakes !== true;
  const prompt = useOperation(state, "thread_prompt", { name: thread.id }, [], prompted);
  const character = state.character ?? "The character";
  return <Form title="Thread settings" close={close} busy={busy} error={error} action="Save" submit={() => run(async () => await saveThreadSettings(thread, { label, purpose, pins: threadPinList(pins), locked, model, compaction }))}>
    <label className="field"><span>Label</span><input className="input" data-autofocus value={label} placeholder={thread.id} onChange={(event) => setLabel(event.target.value)} /></label>
    <p className="form-hint">Leave empty to show the thread’s name, “{thread.id}”.</p>
    {thread.home || !prompted ? null : <label className="field"><span>Purpose <span className="muted">(optional)</span></span><textarea className="input textarea" rows={2} value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>}
    {prompted ? <>
      <PinsField value={pins} change={setPins} note="optional" hint={`The character sees ${thread.home ? "these pins" : "the purpose and these pins"} in this thread’s prompt. One per line: a workspace path or [[link]], or a shell command after a ! whose output is shown instead.`}>
        <button type="button" className="button" disabled={prompt.data === undefined} onClick={() => setViewing(true)}>View prompt…</button>
      </PinsField>
      <SavedPinsField prompt={prompt} />
    </> : null}
    <div className="field">
      <span>Model</span>
      <button type="button" className="button thread-model" aria-label={`Model: ${model ?? `${character}’s default`}. Change model`} onClick={() => setPicking(true)}><span className="mono">{model === null ? `${character}’s default` : shortModel(model)}</span></button>
    </div>
    {thread.wakes === true ? null : <WhenLongField compaction={compaction} setCompaction={setCompaction} />}
    <label className="check"><input type="checkbox" checked={locked} onChange={(event) => setLocked(event.target.checked)} />Lock the label, purpose and pins</label>
    <p className="form-hint">Only you can change a locked thread’s label, purpose and pins. {character} can still edit the pinned files themselves.</p>
    {picking ? <ModelPicker state={state} close={() => setPicking(false)} target={{ kind: "thread", id: thread.id }} scopes={false} current={model} pick={setModel} /> : null}
    {viewing && prompt.data !== undefined ? <ThreadPromptDialog thread={thread} label={threadLabel(thread)} view={prompt.data} replying={conversation.activeIn({ character: state.character, thread: thread.id })} close={() => setViewing(false)} refresh={async () => {
      await workspace.actions.run("thread_prompt_refresh", { name: thread.id });
      await prompt.reload();
    }} /> : null}
  </Form>;
}

function ForkDialog({ thread, taken, close }: { thread: ThreadView; taken: readonly string[]; close: () => void }) {
  const { busy, error, run } = useSubmit(close);
  const [name, setName] = useState("");
  const [turns, setTurns] = useState("");
  return <Form title={`Fork “${threadLabel(thread)}”`} close={close} busy={busy} error={error} action="Fork" disabled={name.trim() === "" || (turns !== "" && !(Number(turns) >= 1))} submit={() => run(async () => {
    const named = namedThread(name, taken);
    const result = await workspace.actions.run("fork_thread", { name: named.id, from: thread.id, ...(turns === "" ? {} : { turns: Number(turns) }) });
    if (named.label !== undefined) await workspace.actions.run("thread_label", { name: result.fork.thread, label: named.label });
    await workspace.openThread(result.fork.thread);
    return `Forked ${String(result.fork.turns)} turns into “${named.label ?? result.fork.thread}”`;
  })}>
    <label className="field"><span>Name</span><input className="input" data-autofocus value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="field"><span>Copy only the last turns <span className="muted">(optional)</span></span><input className="input" inputMode="numeric" placeholder="All turns" value={turns} onChange={(event) => setTurns(event.target.value.replace(/\D/g, ""))} /></label>
  </Form>;
}

function ArchiveDialog({ state, thread, close }: { state: ChromeSnapshot; thread: ThreadView; close: () => void }) {
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

function MoveToFolderDialog({ state, thread, close }: { state: ChromeSnapshot; thread: ThreadView; close: () => void }) {
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

export function ThreadDialogs({ state, request, close }: { state: ChromeSnapshot; request: ThreadDialogRequest; close: () => void }) {
  const thread = state.threads.find((item) => item.id === request.thread);
  if (thread === undefined) return null;
  switch (request.kind) {
    case "settings": return <ThreadSettingsDialog state={state} thread={thread} close={close} />;
    case "fork": return <ForkDialog thread={thread} taken={state.threads.map((each) => each.id)} close={close} />;
    case "archive": return <ArchiveDialog state={state} thread={thread} close={close} />;
    case "move": return <MoveToFolderDialog state={state} thread={thread} close={close} />;
  }
}
