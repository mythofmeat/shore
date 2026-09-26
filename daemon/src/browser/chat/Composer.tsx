import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { ImageUpload } from "../../protocol/ImageUpload.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { browserDraft, type DraftContent } from "../drafts.ts";
import { checkAttachments, imageUpload } from "../request_forms.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "../../swp/limits.ts";
import { IconButton } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import { conversation, errorText, streamReplies, useConversationActive, workspace } from "../app/state.ts";
import { swipe } from "./actions.ts";
import { EffortChip } from "./effort.tsx";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

async function readImage(file: File): Promise<ImageUpload> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Choose PNG, JPEG, WebP or GIF images");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`Choose images no larger than ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MiB`);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.split(",", 2)[1] ?? "") : reject(new Error("Couldn’t read the image"));
    reader.onerror = () => reject(new Error("Couldn’t read the image"));
    reader.readAsDataURL(file);
  });
  return imageUpload(file, data);
}

export function Composer({ state, character, mobile }: { state: WorkspaceSnapshot; character: string; mobile: boolean }) {
  const key = JSON.stringify([state.character, state.thread]);
  const [store] = useState(() => browserDraft(key));
  const [draft, setDraft] = useState<DraftContent>({ text: "", images: [] });
  const current = useRef(draft);
  const mounted = useRef(true);
  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const active = useConversationActive();
  const streaming = active || state.streams.some((stream) => !stream.final && stream.subagent === null);
  const request = state.requests.find((item) => item.name === "message");
  const ready = state.status === "ready" && request?.available !== false;

  const change = async (next: DraftContent): Promise<void> => {
    current.current = next; setDraft(next);
    try { await store.save(next); } catch (error) { setUnsaved(true); workspace.report(error); }
  };
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    const unsubscribe = store.subscribe((value) => { current.current = value; setDraft(value); setUnsaved(store.unsaved && !store.saving); });
    void store.load().then((value) => { if (alive) { const latest = store.current ?? value; current.current = latest; setDraft(latest); setLoaded(true); } })
      .catch(() => { if (alive) { setLoaded(true); setUnsaved(true); } });
    return () => { alive = false; mounted.current = false; unsubscribe(); };
  }, [store]);
  useLayoutEffect(() => {
    const node = area.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${String(Math.min(node.scrollHeight, mobile ? 160 : 280))}px`;
  }, [draft.text, mobile]);
  useEffect(() => { if (loaded && !mobile) area.current?.focus(); }, [loaded, mobile, key]);

  const attach = async (list: readonly File[]) => {
    if (list.length === 0) return;
    try {
      if (list.length + current.current.images.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${String(MAX_ATTACHMENTS)} images`);
      const added = await Promise.all(list.map(readImage));
      const value = store.current ?? current.current;
      const images = [...value.images, ...added];
      checkAttachments(images);
      await change({ ...value, images });
    } catch (error) { toasts.show(errorText(error), "error"); }
  };
  const send = async () => {
    const submitted = current.current;
    if (!loaded || !ready) return;
    if (submitted.text.trim() === "" && submitted.images.length === 0) return;
    if (streaming) { toasts.show("Wait for the reply to finish, or stop it, before sending again.", "error"); return; }
    const connection = workspace.connection;
    const selected = workspace.getSnapshot();
    const synced = connection.selection;
    if (connection.status !== "ready" || selected.character !== state.character || selected.thread !== state.thread || synced.character !== state.character || synced.thread !== state.thread) {
      toasts.show("The conversation changed before sending. Your draft was kept.", "error");
      return;
    }
    try { checkAttachments(submitted.images); } catch (error) { toasts.show(errorText(error), "error"); return; }
    let accepted = false;
    const finished = conversation.submit("message", { stream: streamReplies(), text: submitted.text, image_data: submitted.images }, () => { accepted = true; });
    void finished.catch(() => {});
    const restore = async () => {
      if (accepted) return;
      const value = store.current ?? current.current;
      const next = { ...value, text: [submitted.text, value.text].filter((part) => part !== "").join("\n\n"), images: [...submitted.images, ...value.images] };
      if (mounted.current) await change(next); else await store.save(next).catch(() => {});
    };
    await change({ ...submitted, text: "", images: [] });
    try {
      const result = await finished;
      if (result.outcome === "completed") return;
      if (accepted) { if (result.outcome === "failed") toasts.show(result.error?.message ?? "The reply failed.", "error"); return; }
      await restore();
      if (result.outcome !== "cancelled") toasts.show(result.error?.message ?? `The message wasn’t sent (${result.outcome}). Your draft was restored.`, "error");
    } catch (error) { await restore(); toasts.show(errorText(error), "error"); }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (pasted.length > 0) { event.preventDefault(); void attach(pasted); }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDragging(false);
    void attach([...event.dataTransfer.files]);
  };
  const empty = draft.text.trim() === "" && draft.images.length === 0;
  return <div className="composer-wrap">
    <div className={`composer ${dragging ? "dragging" : ""}`} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {draft.images.length === 0 ? null : <div className="attachments">
        {draft.images.map((image, index) => <div key={index} className="attachment">
          <img src={`data:${image.mime_type ?? "image/png"};base64,${image.data}`} alt={image.filename} />
          <button type="button" className="attachment-remove" aria-label={`Remove ${image.filename}`} onClick={() => void change({ ...current.current, images: current.current.images.filter((_, item) => item !== index) })}><Icon name="close" size={12} /></button>
        </div>)}
      </div>}
      <textarea ref={area} id="message-composer" aria-label="Message" placeholder={`Message ${character}`} rows={1} value={draft.text} disabled={!loaded}
        onChange={(event) => void change({ ...current.current, text: event.target.value })} onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          const blank = current.current.text === "" && current.current.images.length === 0;
          const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
          if (event.key === "Escape") {
            event.preventDefault();
            if (streaming) conversation.cancel();
            else document.querySelector<HTMLElement>(".transcript")?.focus();
            return;
          }
          if (blank && plain && event.key === "ArrowUp") { event.preventDefault(); dispatchEvent(new CustomEvent("shore:edit-last")); return; }
          if (blank && plain && (event.key === "ArrowLeft" || event.key === "ArrowRight") && !streaming) {
            const last = state.messages.findLast((message) => message.role === "assistant");
            if (last !== undefined) { event.preventDefault(); void swipe(last, event.key === "ArrowLeft" ? "prev" : "next", true).catch((error: unknown) => toasts.show(errorText(error), "error")); }
            return;
          }
          if (event.key !== "Enter") return;
          const submit = event.ctrlKey || event.metaKey || (!mobile && !event.shiftKey && !event.altKey);
          if (submit) { event.preventDefault(); void send(); }
        }} />
      <div className="composer-bar">
        <IconButton icon="attach" label="Attach image" disabled={!loaded} onClick={() => files.current?.click()} />
        <input ref={files} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden onChange={(event) => { const list = [...(event.target.files ?? [])]; event.target.value = ""; void attach(list); }} />
        <EffortChip state={state} />
        <span className="composer-status">{unsaved ? "Draft not saved in this browser" : ""}</span>
        {streaming ? <button type="button" className="stop" onClick={() => conversation.cancel()}><Icon name="stop" size={14} />Stop</button>
          : <button type="button" className="send" aria-label="Send" title="Send" disabled={empty || !ready} onClick={() => void send()}><Icon name="send" /></button>}
      </div>
    </div>
  </div>;
}
