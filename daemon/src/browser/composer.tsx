import { RequestFields } from "./request_fields.tsx";
import { checkAttachments, conversationRequest, imageUpload, remainingMessageOptions } from "./request_forms.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "../swp/limits.ts";
import { useEffect, useRef, useState } from "react";
import type { ImageUpload } from "../protocol/ImageUpload.ts";
import type { Workspace, WorkspaceSnapshot } from "./workspace.ts";
import { browserDraft, discardDraft, readDraft, storedDrafts, type DraftContent, type StoredDraft } from "./drafts.ts";
import { Modal } from "./components.tsx";

export function Composer({ state, workspace }: { state: WorkspaceSnapshot; workspace: Workspace }) {
  const conversation = JSON.stringify([state.character, state.thread]);
  const [store] = useState(() => browserDraft(conversation));
  const [draft, setDraft] = useState<DraftContent>({ text: "", images: [], pending: false });
  const current = useRef(draft);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("Loading draft…");
  const [storageFailed, setStorageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const request = state.requests.find((item) => item.name === "message");
  const options = draft.options ?? { stream: true, images: [] };
  const imagePaths = Array.isArray(options["images"]) ? options["images"] : [];
  const [saved, setSaved] = useState<StoredDraft[]>();
  const [discarding, setDiscarding] = useState<StoredDraft>();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const sequence = useRef(0);
  const perform = (work: () => Promise<unknown>) => { void work().catch((error: unknown) => workspace.report(error)); };
  const remember = async (next: DraftContent): Promise<void> => {
    const revision = ++sequence.current;
    setStatus("Saving draft…");
    try {
      await store.save(next);
      if (revision === sequence.current) { setStatus("Draft saved on this device"); setStorageFailed(false); }
    } catch (error) {
      if (revision === sequence.current) { setStatus("Draft not saved. Keep this page open."); setStorageFailed(true); }
      workspace.report(error);
    }
  };
  const change = (next: DraftContent): Promise<void> => { current.current = next; setDraft(next); return remember(next); };
  useEffect(() => {
    let mounted = true;
    void store.load().then((value) => {
      if (mounted) { current.current = value; setDraft(value); setLoaded(true); setStorageFailed(store.unsaved); setStatus(store.unsaved ? "Draft not saved. Keep this page open." : "Draft saved on this device"); }
    }).catch((error: unknown) => {
      if (mounted) { workspace.report(error); setLoaded(true); setStorageFailed(true); setStatus("Draft storage unavailable. Keep this page open."); }
    });
    const focus = (event: KeyboardEvent) => { if (event.altKey && event.key === "m") { event.preventDefault(); textRef.current?.focus(); } };
    window.addEventListener("keydown", focus);
    return () => { mounted = false; window.removeEventListener("keydown", focus); };
  }, [store, workspace]);
  const send = async () => {
    if (!loaded || busy || attaching || current.current.pending || state.status !== "ready" || state.character === null || request?.available !== true) return;
    const submitted = current.current;
    const values = submitted.options ?? { stream: true, images: [] };
    const message = conversationRequest("message", { ...values, text: submitted.text, image_data: submitted.images });
    if (submitted.text.trim() === "" && submitted.images.length === 0 && (message.images?.length ?? 0) === 0) return;
    checkAttachments(submitted.images);
    setBusy(true);
    await change({ ...submitted, pending: true });
    try {
      const result = await workspace.connection.submit(message).finished;
      if (result.outcome === "completed") {
        const value = current.current;
        await change({ ...(value.options === undefined ? {} : { options: remainingMessageOptions(value.options, submitted.options ?? {}) }), text: value.text === submitted.text ? "" : value.text, images: value.images === submitted.images ? [] : value.images, pending: false });
      } else workspace.report(result.error?.message ?? `Request ${result.outcome}. Inspect the conversation before sending the retained draft again.`);
    } catch (error) { workspace.report(error); } finally { setBusy(false); }
  };
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
  const refresh = async () => { setSaved(await storedDrafts()); };
  const restore = async (record: StoredDraft) => {
    const recovered = await readDraft(record.id, record.conversation);
    if (recovered === undefined) throw new Error("That draft was removed. Refresh the saved drafts.");
    await change(recovered.content); setSaved(undefined); textRef.current?.focus();
  };
  return <>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); perform(send); }}>
      <label className="sr-only" htmlFor="message-composer">Message</label>
      <textarea id="message-composer" ref={textRef} rows={3} disabled={!loaded} placeholder={state.character === null ? "Create or select a character to begin" : `Message ${state.character}…`} value={draft.text} onChange={(event) => { void change({ ...current.current, text: event.target.value }); }} onPaste={(event) => {
        const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
        if (images.length > 0) { event.preventDefault(); perform(() => attach(images)); }
      }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); perform(send); } }} />
      {draft.images.length === 0 ? null : <div className="attachments">{draft.images.map((image, index) => <button type="button" key={index} onClick={() => { void change({ ...current.current, images: current.current.images.filter((_, position) => position !== index) }); }}>Remove {image.filename}</button>)}<button type="button" onClick={() => { void change({ ...current.current, images: [] }); }}>Clear attachments</button></div>}
      {draft.pending && !busy ? <div className="notice"><strong>Previous send needs review</strong><p>This draft may already be in the conversation. Check the history before sending it again.</p><button type="button" onClick={() => { void change({ ...current.current, pending: false }); }}>I checked the conversation</button></div> : null}
      <div className="composer-footer"><label className="attach">Attach images<input aria-label="Attach images" className="sr-only" type="file" disabled={!loaded || attaching} accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; perform(() => attach(files)); }} /></label><button type="button" disabled={!loaded || request === undefined} onClick={() => setOptionsOpen(true)}>Message options</button><small role="status">{attaching ? "Adding images…" : status}</small><button type="button" onClick={() => perform(refresh)} disabled={!loaded}>Saved drafts</button>{storageFailed ? <button type="button" onClick={() => { void remember(current.current); }}>Retry saving</button> : null}<button type="button" onClick={() => workspace.connection.cancel()} disabled={state.status !== "ready"}>Stop</button><button type="submit" className="primary" disabled={!loaded || busy || attaching || draft.pending || state.status !== "ready" || state.character === null || request?.available !== true || (draft.text.trim() === "" && draft.images.length === 0 && imagePaths.length === 0)}>{busy ? "Sending…" : "Send"}</button></div>
      <small>Ctrl/⌘ Enter to send · Text and attachments stay on this device until sent or discarded. Clearing browser data removes saved drafts.</small>
    </form>
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
