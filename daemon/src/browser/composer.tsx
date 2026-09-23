import { TextHistory, textSnapshot, type TextSnapshot } from "./text_history.ts";
import { RequestFields } from "./request_fields.tsx";
import { checkAttachments, conversationRequest, imageUpload, remainingMessageOptions } from "./request_forms.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "../swp/limits.ts";
import { useEffect, useRef, useState, useImperativeHandle, type Ref, type KeyboardEvent, type ChangeEvent, type ClipboardEvent } from "react";
import type { ImageUpload } from "../protocol/ImageUpload.ts";
import type { RequestFinished } from "../protocol/RequestFinished.ts";
import type { Workspace, WorkspaceSnapshot } from "./workspace.ts";
import { browserDraft, discardDraft, readDraft, storedDrafts, type DraftContent, type StoredDraft } from "./drafts.ts";
import { Modal } from "./components.tsx";

export interface ComposerHandle { send(): Promise<void>; focus(edge?: "home" | "end"): void; attach(): void; clearImages(): void; expand(): void; undo(): void; redo(): void }

export function Composer({ state, workspace, ref }: { state: WorkspaceSnapshot; workspace: Workspace; ref?: Ref<ComposerHandle> }) {
  const conversation = JSON.stringify([state.character, state.thread]);
  const [store] = useState(() => browserDraft(conversation));
  const [draft, setDraft] = useState<DraftContent>({ text: "", images: [], pending: false });
  const current = useRef(draft);
  const mounted = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("Loading draft…");
  const [storageFailed, setStorageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [textHistory] = useState(() => new TextHistory());
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const selection = useRef<TextSnapshot | undefined>(undefined);
  const historyCommand = useRef<(direction: "undo" | "redo") => void>(() => {});
  const [optionsOpen, setOptionsOpen] = useState(false);
  const request = state.requests.find((item) => item.name === "message");
  const options = draft.options ?? { stream: true, images: [] };
  const imagePaths = Array.isArray(options["images"]) ? options["images"] : [];
  const [saved, setSaved] = useState<StoredDraft[]>();
  const [discarding, setDiscarding] = useState<StoredDraft>();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const perform = (work: () => Promise<unknown>) => { void work().catch((error: unknown) => workspace.report(error)); };
  const remember = async (next: DraftContent): Promise<void> => {
    try { await store.save(next); } catch (error) { workspace.report(error); }
  };
  const change = (next: DraftContent, edit?: { snapshot: TextSnapshot; inputType?: string }, restoring = false): Promise<void> => {
    if (!restoring && next.text !== current.current.text) textHistory.change(edit?.snapshot ?? textSnapshot(next.text), edit?.inputType);
    current.current = next; setDraft(next); return remember(next);
  };
  const navigateHistory = (direction: "undo" | "redo") => {
    if (!loaded) return;
    const snapshot = textHistory.step(direction);
    if (snapshot === undefined) return;
    selection.current = snapshot;
    void change({ ...current.current, text: snapshot.text }, undefined, true);
  };
  historyCommand.current = navigateHistory;
  useEffect(() => {
    const target = expanded ? editorRef.current : textRef.current;
    const savedSelection = selection.current;
    if (target !== null && savedSelection !== undefined) {
      target.focus(); target.setSelectionRange(savedSelection.start, savedSelection.end, savedSelection.direction); selection.current = undefined;
    }
  }, [draft.text, expanded]);
  useEffect(() => {
    const elements = [textRef.current, editorRef.current].filter((element) => element !== null);
    const before = (event: InputEvent) => {
      const target = event.currentTarget as HTMLTextAreaElement;
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        if (document.activeElement === target) historyCommand.current(event.inputType === "historyUndo" ? "undo" : "redo");
        return;
      }
      textHistory.select(target.selectionStart, target.selectionEnd, target.selectionDirection);
    };
    for (const element of elements) element.addEventListener("beforeinput", before);
    return () => { for (const element of elements) element.removeEventListener("beforeinput", before); };
  }, [expanded, textHistory]);
  const openEditor = () => { if (loaded) { textHistory.breakGroup(); selection.current = textHistory.current; setExpanded(true); } };
  const closeEditor = () => { textHistory.breakGroup(); selection.current = textHistory.current; setExpanded(false); };
  const editText = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    const inputType = event.nativeEvent instanceof InputEvent ? event.nativeEvent.inputType : "";
    void change({ ...current.current, text: target.value }, { snapshot: textSnapshot(target.value, target.selectionStart, target.selectionEnd, target.selectionDirection), inputType });
  };
  const editKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    event.preventDefault(); event.stopPropagation();
    navigateHistory(key === "y" || event.shiftKey ? "redo" : "undo");
  };
  const selectText = (target: HTMLTextAreaElement) => textHistory.select(target.selectionStart, target.selectionEnd, target.selectionDirection);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    const receive = (value: DraftContent) => {
      if (value.text !== current.current.text) textHistory.change(textSnapshot(value.text));
      current.current = value; setDraft(value);
      setStorageFailed(store.unsaved && !store.saving);
      setStatus(store.saving ? "Saving draft…" : store.unsaved ? "Draft not saved. Keep this page open." : "Draft saved on this device");
    };
    const unsubscribe = store.subscribe(receive);
    void store.load().then((value) => {
      if (active) { const latest = store.current ?? value; textHistory.reset(latest.text); receive(latest); setLoaded(true); }
    }).catch((error: unknown) => {
      if (active) { workspace.report(error); setLoaded(true); setStorageFailed(true); setStatus("Draft storage unavailable. Keep this page open."); }
    });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, [store, workspace, textHistory]);
  const send = async () => {
    if (!loaded || busy || attaching || current.current.pending || state.status !== "ready" || state.character === null || request?.available !== true) return;
    const submitted = current.current;
    const values = submitted.options ?? { stream: true, images: [] };
    const message = conversationRequest("message", { ...values, text: submitted.text, image_data: submitted.images });
    if (submitted.text.trim() === "" && submitted.images.length === 0 && (message.images?.length ?? 0) === 0) return;
    checkAttachments(submitted.images);
    const connection = workspace.connection;
    const generation = connection.generation;
    const retain = async (): Promise<void> => {
      const retained = { ...(store.current ?? current.current), pending: false };
      if (mounted.current) await change(retained);
      else await store.save(retained).catch(() => {});
    };
    setBusy(true);
    try {
      await change({ ...submitted, pending: true });
      const selected = workspace.getSnapshot();
      const synced = connection.selection;
      if (!mounted.current || generation !== connection.generation || connection.status !== "ready" ||
        selected.character !== state.character || selected.thread !== state.thread ||
        synced.character !== state.character || synced.thread !== state.thread) {
        await retain();
        workspace.report("Conversation changed before sending. Your draft was retained.");
        return;
      }
      let finished: Promise<RequestFinished>;
      try { finished = connection.submit(message).finished; } catch (error) { await retain(); throw error; }
      const result = await finished;
      if (result.outcome === "completed") {
        const value = store.current ?? current.current;
        await change({ ...(value.options === undefined ? {} : { options: remainingMessageOptions(value.options, submitted.options ?? {}) }), text: value.text === submitted.text ? "" : value.text, images: value.images === submitted.images ? [] : value.images, pending: false });
      } else workspace.report(result.error?.message ?? `Request ${result.outcome}. Inspect the conversation before sending the retained draft again.`);
    } catch (error) { workspace.report(error); } finally { setBusy(false); }
  };
  const focus = (edge?: "home" | "end") => {
    const target = textRef.current;
    if (target === null) return;
    const text = current.current.text;
    const cursor = textHistory.current.start;
    const end = text.indexOf("\n", cursor);
    const next = edge === "home" ? text.slice(0, cursor).lastIndexOf("\n") + 1 : edge === "end" ? end < 0 ? text.length : end : undefined;
    target.focus();
    if (next !== undefined) { target.setSelectionRange(next, next); textHistory.select(next, next, "none"); }
  };
  useImperativeHandle(ref, () => ({ send, focus, attach: () => { if (loaded && !attaching) filesRef.current?.click(); }, clearImages: () => { if (loaded) void change({ ...current.current, images: [], options: { ...current.current.options, images: [] } }); }, expand: openEditor, undo: () => navigateHistory("undo"), redo: () => navigateHistory("redo") }));
  const attach = async (files: readonly File[]) => {
    if (files.length === 0) return;
    setAttaching(true);
    try {
      if (files.length + current.current.images.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} images`);
      const added: ImageUpload[] = [];
      for (const file of files) {
        if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) throw new Error("Choose PNG, JPEG, WebP or GIF images");
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`Choose images no larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB`);
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.split(",", 2)[1] ?? "") : reject(new Error("Could not read image"));
          reader.onerror = () => reject(new Error("Could not read image")); reader.readAsDataURL(file);
        });
        added.push(imageUpload(file, data));
      }
      const images = [...current.current.images, ...added];
      checkAttachments(images);
      await change({ ...current.current, images });
    } finally { setAttaching(false); }
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (images.length > 0) { event.preventDefault(); perform(() => attach(images)); }
  };
  const historyButtons = <><button type="button" aria-label="Undo text change" disabled={!loaded || !textHistory.canUndo} onClick={() => navigateHistory("undo")}>Undo</button><button type="button" aria-label="Redo text change" disabled={!loaded || !textHistory.canRedo} onClick={() => navigateHistory("redo")}>Redo</button></>;
  const lastReply = state.messages.findLast((message) => message.role === "assistant");
  const replyText = lastReply === undefined ? "" : lastReply.content_blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n") || lastReply.content;
  const refresh = async () => { setSaved(await storedDrafts()); };
  const restore = async (record: StoredDraft) => {
    const recovered = await readDraft(record.id, record.conversation);
    if (recovered === undefined) throw new Error("That draft was removed. Refresh the saved drafts.");
    await change(recovered.content); setSaved(undefined); textRef.current?.focus();
  };
  return <>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); perform(send); }}>
      <label className="sr-only" htmlFor="message-composer">Message</label>
      <textarea id="message-composer" ref={textRef} rows={3} disabled={!loaded} placeholder={state.character === null ? "Create or select a character to begin" : `Message ${state.character}…`} value={draft.text} onChange={editText} onKeyDown={editKey} onBlur={() => textHistory.breakGroup()} onCompositionStart={() => textHistory.beginComposition()} onCompositionEnd={() => textHistory.endComposition()} onSelect={(event) => selectText(event.currentTarget)} onPaste={paste} />
      {draft.images.length === 0 ? null : <div className="attachments">{draft.images.map((image, index) => <button type="button" key={index} onClick={() => { void change({ ...current.current, images: current.current.images.filter((_, position) => position !== index) }); }}>Remove {image.filename}</button>)}<button type="button" onClick={() => { void change({ ...current.current, images: [] }); }}>Clear attachments</button></div>}
      {draft.pending && !busy ? <div className="notice"><strong>Previous send needs review</strong><p>This draft may already be in the conversation. Check the history before sending it again.</p><button type="button" onClick={() => { void change({ ...current.current, pending: false }); }}>I checked the conversation</button></div> : null}
      <div className="composer-footer"><button type="button" disabled={!loaded} onClick={openEditor}>Expand editor</button>{historyButtons}<label className="attach">Attach images<input ref={filesRef} aria-label="Attach images" className="sr-only" type="file" disabled={!loaded || attaching} accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; perform(() => attach(files)); }} /></label><button type="button" disabled={!loaded || request === undefined} onClick={() => setOptionsOpen(true)}>Message options</button><small role="status">{attaching ? "Adding images…" : status}</small><button type="button" onClick={() => perform(refresh)} disabled={!loaded}>Saved drafts</button>{storageFailed ? <button type="button" onClick={() => { void remember(current.current); }}>Retry saving</button> : null}<button type="button" onClick={() => workspace.connection.cancel()} disabled={state.status !== "ready"}>Stop</button><button type="submit" className="primary" disabled={!loaded || busy || attaching || draft.pending || state.status !== "ready" || state.character === null || request?.available !== true || (draft.text.trim() === "" && draft.images.length === 0 && imagePaths.length === 0)}>{busy ? "Sending…" : "Send"}</button></div>
      <small>Keyboard shortcuts are configurable · Text and attachments stay on this device until sent or discarded. Clearing browser data removes saved drafts.</small>
    </form>
    {expanded ? <Modal title="Draft editor" close={closeEditor}>
      <div className="draft-editor"><label htmlFor="expanded-draft">Expanded draft</label><textarea id="expanded-draft" ref={editorRef} rows={16} value={draft.text} onChange={editText} onKeyDown={editKey} onBlur={() => textHistory.breakGroup()} onCompositionStart={() => textHistory.beginComposition()} onCompositionEnd={() => textHistory.endComposition()} onSelect={(event) => selectText(event.currentTarget)} onPaste={paste} />
      <div className="actions">{historyButtons}<button onClick={closeEditor}>Return to composer</button></div><p role="status">{attaching ? "Adding images…" : status}</p>
      {storageFailed ? <button onClick={() => { void remember(current.current); }}>Retry saving</button> : null}
      <p>Changes save to this device as you type. Closing keeps your draft. Undo restores recent text changes, including sent text; it does not send a message or restore removed attachments.</p>
      <p>{draft.images.length + imagePaths.length} queued image(s)</p>
      <section aria-label="Last assistant reply"><h3>Last assistant reply</h3><p className="muted">Reference only. This reply is not included in your draft.</p><div className="message-text">{replyText || "No assistant reply yet."}</div></section></div>
    </Modal> : null}
    {optionsOpen && request !== undefined ? <Modal title="Message options" close={() => setOptionsOpen(false)}><RequestFields request={request} values={options} omit={["text", "image_data"]} change={(values) => { void change({ ...current.current, options: values }); }} /></Modal> : null}
    {saved === undefined ? null : <Modal title="Saved drafts" close={() => { setSaved(undefined); setDiscarding(undefined); }}>
      <p>Each tab has its own draft. Copy a saved draft into an empty composer to recover it; the saved copy stays available until discarded.</p>
      <button onClick={() => perform(refresh)}>Refresh saved drafts</button>
      {saved.length === 0 ? <p>No saved drafts.</p> : saved.map((record) => <section className="result" key={record.id} aria-label="Saved draft">
        <strong>{(JSON.parse(record.conversation) as (string | null)[]).map((part) => part ?? "No selection").join(" / ")}</strong><time>{new Date(record.updated).toLocaleString()}</time><p>{record.text.slice(0, 200)}</p><p>{record.imageCount} image(s){record.pending ? " · Previous send needs review" : ""}</p>
        <button disabled={busy || draft.text !== "" || draft.images.length > 0 || imagePaths.length > 0 || draft.pending || record.conversation !== conversation} onClick={() => perform(() => restore(record))}>Copy into composer</button>
        <button onClick={() => setDiscarding(record)}>Discard saved draft</button>
      </section>)}
      {discarding === undefined ? null : <div className="confirmation"><p>Discard this saved text and its attachments? An open tab may still hold a separate copy.</p><button onClick={() => setDiscarding(undefined)}>Keep draft</button><button className="danger" onClick={() => perform(async () => { await discardDraft(discarding); setDiscarding(undefined); await refresh(); })}>Confirm discard</button></div>}
    </Modal>}
  </>;
}
