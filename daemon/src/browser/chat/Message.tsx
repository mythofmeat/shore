import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CharacterAvatar } from "../../protocol/CharacterAvatar.ts";
import type { AlternativeListing } from "../../protocol/AlternativeListing.ts";
import type { Message } from "../../protocol/Message.ts";
import type { StreamMetadata } from "../../protocol/StreamMetadata.ts";
import type { ViewValues } from "../preferences.ts";
import { copyText } from "../clipboard.ts";
import { mediaSource } from "../media.ts";
import { metadataLabel } from "../metadata.ts";
import { Markdown } from "../markdown.tsx";
import { Avatar, UserAvatar } from "../ui/avatar.tsx";
import { Dialog, IconButton, Menu, Spinner, type MenuItem } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import { conversation, errorText, streamReplies, workspace } from "../app/state.ts";
import { activityHeadline, blockViews, bodyItems, formatToolInput, swipeState, timeLabel, toolSummary, type BlockView, type StepView } from "./transcript.ts";
import { swipe as swipeTo } from "./actions.ts";

export type OpenImage = (source: string, caption: string) => void;

function ReasoningChip({ text, redacted = false, live = false }: { text: string; redacted?: boolean; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (redacted) return <div className="chip static"><span>Reasoning hidden by the provider</span></div>;
  return <div className="reasoning">
    <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{live ? "Thinking…" : "Reasoning"}</span><Icon name={open ? "chevronUp" : "chevronRight"} size={14} />
    </button>
    {open ? <div className="reasoning-text"><Markdown text={text} /></div> : null}
  </div>;
}

function ToolChip({ view, openImage }: { view: Extract<BlockView, { kind: "tool" }>; openImage: OpenImage }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(view.input);
  const running = view.output === null;
  const input = formatToolInput(view.input);
  return <div className={`tool ${open ? "open" : ""}`}>
    <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="terminal" size={14} />
      <span className="tool-name">{view.name}</span>
      {summary === "" ? null : <span className="tool-summary mono">{summary}</span>}
      {running ? <span className="spinner" aria-label="Running" /> : view.error ? <span className="tool-status error"><Icon name="alert" size={14} /><span className="sr-only">Failed</span></span> : <span className="tool-status ok"><Icon name="check" size={14} /><span className="sr-only">Done</span></span>}
      <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
    </button>
    {open ? <div className="tool-body">
      {input === "" ? null : <><div className="tool-label">Input</div><pre className="mono">{input}</pre></>}
      {view.output === null ? <div className="tool-label">Running…</div> : <><div className="tool-label">{view.error ? "Error" : "Output"}</div><pre className="mono">{view.output === "" ? "(no output)" : view.output}</pre></>}
      {view.images.length === 0 ? null : <div className="images">{view.images.map((source, index) => <ImageThumb key={index} source={source} caption={`${view.name} image ${String(index + 1)}`} open={openImage} />)}</div>}
    </div> : null}
  </div>;
}

export function ImageThumb({ source, caption, open }: { source: string; caption: string; open: OpenImage }) {
  return <button type="button" className="image-thumb" onClick={() => open(source, caption)} aria-label={`Open ${caption}`}><img src={source} alt={caption} loading="lazy" /></button>;
}

function Step({ step, live, openImage }: { step: StepView; live: boolean; openImage: OpenImage }) {
  return step.kind === "thinking" ? <ReasoningChip text={step.text} redacted={step.redacted} live={live} /> : <ToolChip view={step} openImage={openImage} />;
}

function Activity({ steps, live, openImage, expanded = false }: { steps: StepView[]; live: boolean; openImage: OpenImage; expanded?: boolean }) {
  const [open, setOpen] = useState(expanded);
  const [only] = steps;
  if (only !== undefined && steps.length === 1) return <Step step={only} live={live} openImage={openImage} />;
  const { label, detail } = activityHeadline(steps, live);
  const failed = steps.filter((step) => step.kind === "tool" && step.error).length;
  return <div className={`activity ${open ? "open" : ""}`}>
    <button type="button" className="activity-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      <span className="activity-label">{label}</span>
      {detail === "" ? null : <span className="activity-detail mono">{detail}</span>}
      {failed === 0 ? null : <span className="tool-status error"><Icon name="alert" size={14} />{failed} failed</span>}
      {live ? <span className="spinner" aria-label="Working" /> : null}
    </button>
    {open ? <div className="activity-steps">{steps.map((step, index) => <Step key={step.key} step={step} live={live && index === steps.length - 1} openImage={openImage} />)}</div> : null}
  </div>;
}

export function MessageBody({ message, display, openImage, live = false, expanded = false }: { message: Pick<Message, "content" | "content_blocks" | "images">; display: ViewValues; openImage: OpenImage; live?: boolean; expanded?: boolean }) {
  const views = message.content_blocks.length === 0 ? [{ kind: "text" as const, key: "content", text: message.content }] : blockViews(message.content_blocks);
  const shown = views.filter((view) => view.kind === "thinking" ? display.thinking !== "off" : view.kind === "tool" ? display.tools !== "off" : view.kind !== "image" || display.images !== "off");
  const items = bodyItems(shown);
  const images = display.images === "off" ? [] : message.images.flatMap((image) => {
    const source = mediaSource(image.data);
    return source === undefined ? [] : [{ source, caption: image.caption ?? image.path.split(/[\\/]/).at(-1) ?? "Image" }];
  });
  return <>
    {items.map((item, index): ReactNode => {
      const latest = live && index === items.length - 1;
      switch (item.kind) {
        case "text": return <Markdown key={item.key} text={item.text} className={latest ? "prose streaming-text" : "prose"} />;
        case "image": return <div key={item.key} className="images"><ImageThumb source={item.source} caption="Image" open={openImage} /></div>;
        case "activity": return <Activity key={item.key} steps={item.steps} live={latest} openImage={openImage} expanded={expanded} />;
      }
    })}
    {images.length === 0 ? null : <div className="images">{images.map((image, index) => <ImageThumb key={index} source={image.source} caption={image.caption} open={openImage} />)}</div>}
  </>;
}

function EditBox({ message, done }: { message: Message; done: () => void }) {
  const [text, setText] = useState(message.content);
  const [original, setOriginal] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const typed = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const node = area.current; if (node !== null) { node.focus(); node.setSelectionRange(node.value.length, node.value.length); } }, []);
  useEffect(() => {
    let alive = true;
    workspace.actions.run("get", { ref: message.msg_id }, { remember: false }).then((latest) => {
      if (!alive) return;
      setOriginal(latest.content);
      if (!typed.current) setText(latest.content);
    }).catch(() => {});
    return () => { alive = false; };
  }, [message.msg_id]);
  useEffect(() => { const node = area.current; if (node !== null) { node.style.height = "auto"; node.style.height = `${String(Math.min(node.scrollHeight + 2, 480))}px`; } }, [text]);
  const save = async () => {
    if (text === original) { done(); return; }
    setBusy(true);
    try { await workspace.actions.run("edit", { ref: message.msg_id, content: text }); done(); }
    catch (error) { toasts.show(errorText(error), "error"); }
    finally { setBusy(false); }
  };
  return <div className="edit-box">
    <textarea ref={area} aria-label="Edit message" value={text} disabled={busy} onChange={(event) => { typed.current = true; setText(event.target.value); }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); done(); }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
    }} />
    <div className="edit-actions">
      <span className="edit-hint">Esc to cancel · Ctrl+Enter to save</span>
      <button type="button" className="button" onClick={done}>Cancel</button>
      <button type="button" className="button primary" disabled={busy || text.trim() === ""} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
    </div>
  </div>;
}

function DeleteConfirm({ message, done }: { message: Message; done: () => void }) {
  const [busy, setBusy] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirm.current?.focus(); }, []);
  const remove = async () => {
    setBusy(true);
    try { await workspace.actions.run("delete", { refs: message.msg_id }); }
    catch (error) { toasts.show(errorText(error), "error"); setBusy(false); done(); }
  };
  return <div className="confirm-bar" role="group" aria-label="Confirm deletion">
    <span>Delete this message?</span>
    <button type="button" className="button" onClick={done}>Cancel</button>
    <button type="button" ref={confirm} className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete"}</button>
  </div>;
}

function AlternativesDialog({ message, close }: { message: Message; close: () => void }) {
  const [listing, setListing] = useState<AlternativeListing>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    workspace.actions.run("list_alternatives", { ref: message.msg_id }, { remember: false }).then((result) => { if (alive) setListing(result); }).catch((failure: unknown) => { if (alive) setError(errorText(failure)); });
    return () => { alive = false; };
  }, [message.msg_id]);
  const choose = async (position: number) => {
    setBusy(true);
    try { await workspace.actions.run("alt", { ref: message.msg_id, position }); close(); }
    catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return <Dialog title="Responses" close={close} wide>
    {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
    {listing === undefined && error === "" ? <Spinner label="Loading responses" /> : null}
    <div className="alternatives" role="listbox" aria-label="Responses">
      {listing?.alternatives.map((item) => <button key={item.index} type="button" role="option" aria-selected={item.active} className={`alternative ${item.active ? "on" : ""}`} disabled={busy} onClick={() => void choose(item.position)}>
        <span className="alternative-head"><span>Response {item.position}</span>{item.active ? <span className="tag">shown</span> : null}<time dateTime={item.timestamp}>{timeLabel(item.timestamp)}</time></span>
        <span className="alternative-text">{item.content}</span>
      </button>)}
    </div>
  </Dialog>;
}

function Swipe({ message, last, busy }: { message: Message; last: boolean; busy: boolean }) {
  const swipe = swipeState(message);
  const [listing, setListing] = useState(false);
  const move = (direction: "prev" | "next") => { void swipeTo(message, direction, last).catch((error: unknown) => toasts.show(errorText(error), "error")); };
  if (!last && swipe.count <= 1) return null;
  return <div className="swipe" role="group" aria-label="Alternative responses">
    <IconButton icon="chevronLeft" label="Previous response" size={16} disabled={busy || !swipe.canPrevious} onClick={() => move("prev")} />
    <button type="button" className="swipe-count" aria-live="polite" aria-label={`Response ${String(swipe.position)} of ${String(swipe.count)}. Show all responses`} title="Show all responses" disabled={swipe.count <= 1} onClick={() => setListing(true)}><span className="swipe-current">{swipe.position}</span> / {swipe.count}</button>
    <IconButton icon="chevronRight" label={swipe.atLast ? "Generate another response" : "Next response"} size={16} disabled={busy || (swipe.atLast && !last)} onClick={() => move("next")} />
    {listing ? <AlternativesDialog message={message} close={() => setListing(false)} /> : null}
  </div>;
}

export function MessageRow({ message, character, avatar, last, lastUser = false, metadata, display, busy, mobile, openImage }: {
  message: Message; character: string; avatar: CharacterAvatar | null | undefined; last: boolean; lastUser?: boolean; metadata: StreamMetadata | undefined;
  display: ViewValues; busy: boolean; mobile: boolean; openImage: OpenImage;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  useEffect(() => {
    if (!lastUser) return;
    const edit = () => setMode("edit");
    addEventListener("shore:edit-last", edit);
    return () => removeEventListener("shore:edit-last", edit);
  }, [lastUser]);
  const assistant = message.role === "assistant";
  const copy = () => { void copyText(message.content).then(() => toasts.show("Copied")).catch((error: unknown) => toasts.show(errorText(error), "error")); };
  const regenerate = () => { void conversation.regenerate(undefined, streamReplies()).catch((error: unknown) => toasts.show(errorText(error), "error")); };
  if (message.role === "system") return <div className="system-note"><Markdown text={message.content} /></div>;
  const actions: MenuItem[] = [
    { label: "Copy", icon: "copy", onSelect: copy },
    { label: "Edit", icon: "edit", onSelect: () => setMode("edit") },
    ...(assistant && last ? [{ label: "Regenerate", icon: "regenerate" as const, onSelect: regenerate, disabled: busy }] : []),
    { label: "Delete", icon: "trash", onSelect: () => setMode("delete"), danger: true },
  ];
  const time = display.timestamps === "off" ? "" : timeLabel(message.timestamp);
  const meta = display.metadata === "on" ? [metadata === undefined ? message.model ?? "" : metadataLabel(metadata)].filter(Boolean).join(" · ") : "";
  return <article className={`message ${message.role} ${mode !== "view" ? "active" : ""} ${last ? "last" : ""}`} aria-label={`${assistant ? character : "You"}, ${timeLabel(message.timestamp)}`} data-role={message.role}>
    {mode === "view" && !mobile ? <div className="message-actions" role="toolbar" aria-label="Message actions">
      <IconButton icon="copy" label="Copy" onClick={copy} />
      <IconButton icon="edit" label="Edit" onClick={() => setMode("edit")} />
      {assistant && last ? <IconButton icon="regenerate" label="Regenerate" disabled={busy} onClick={regenerate} /> : null}
      <IconButton icon="trash" label="Delete" onClick={() => setMode("delete")} />
    </div> : null}
    {assistant ? <Avatar name={character} avatar={avatar} size={mobile ? 32 : 36} /> : <UserAvatar size={mobile ? 32 : 36} />}
    <div className="message-main">
      <div className="message-meta">
        <span className="message-name">{assistant ? character : "You"}</span>
        {message.origin === "autonomous" ? <span className="tag">unprompted</span> : null}
        {time === "" ? null : <time dateTime={message.timestamp}>{time}</time>}
        {mobile && mode === "view" ? <span className="message-menu"><Menu label="Message actions" items={actions} /></span> : null}
      </div>
      {mode === "edit" ? <EditBox message={message} done={() => setMode("view")} /> : <div className="message-body"><MessageBody message={message} display={display} openImage={openImage} /></div>}
      {meta === "" ? null : <div className="message-metadata">{meta}</div>}
      {assistant && mode === "view" ? <Swipe message={message} last={last} busy={busy} /> : null}
      {mode === "delete" ? <DeleteConfirm message={message} done={() => setMode("view")} /> : null}
    </div>
  </article>;
}
