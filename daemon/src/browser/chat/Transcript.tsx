import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message } from "../../protocol/Message.ts";
import type { SegmentSummary } from "../../protocol/SegmentSummary.ts";
import { liveTurn, type LiveTurn, type SegmentView, type WorkspaceSnapshot } from "../workspace.ts";
import { mediaSource } from "../media.ts";
import { Avatar } from "../ui/avatar.tsx";
import { Dialog, Spinner } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { Markdown } from "../markdown.tsx";
import { FullPicture } from "../pictures.tsx";
import { conversation, perform, useActiveRequests, useDisplay, workspace } from "../app/state.ts";
import { navigate } from "../app/route.ts";
import { ImageThumb, MessageBody, MessageRow, type OpenImage } from "./Message.tsx";
import { compactionPhase, regenReplaces, replyBlocks, savedPart, segmentDetail, segmentName, transcriptItems, visibleStreams } from "./transcript.ts";

function Lightbox({ image, close }: { image: { source: string; caption: string }; close: () => void }) {
  return <Dialog title={image.caption} close={close} wide>
    <FullPicture source={image.source} caption={image.caption} />
    <div className="dialog-footer"><a className="button" href={image.source} download={image.caption}>Download</a></div>
  </Dialog>;
}

function SubagentChip({ stream, openImage }: { stream: LiveTurn; openImage: OpenImage }) {
  const [open, setOpen] = useState(false);
  const display = useDisplay();
  const name = stream.subagent ?? "Subagent";
  return <>
    <button type="button" className="chip" onClick={() => setOpen(true)} aria-label={`${name}: ${stream.final ? "finished" : "working"}. Show its output`}>
      <Icon name="branch" size={14} /><span>{name}</span>{stream.final ? <Icon name="check" size={14} /> : <Spinner label={`${name} working`} />}
    </button>
    {open ? <Dialog title={`Subagent ${name}`} close={() => setOpen(false)} wide>
      <p className="form-text">{stream.final ? "Finished." : "Working…"}</p>
      <MessageBody message={{ content: "", images: [], content_blocks: stream.blocks.filter((block) => block.type !== "text") }} display={display} openImage={openImage} live={!stream.final} expanded />
      {stream.text === "" ? null : <Markdown text={stream.text} />}
    </Dialog> : null}
  </>;
}

function StreamingMessage({ stream, saved, character, state, openImage, mobile }: { stream: LiveTurn; saved: Message | undefined; character: string; state: WorkspaceSnapshot; openImage: OpenImage; mobile: boolean }) {
  const display = useDisplay();
  const images = state.media.filter((image) => image.rid === stream.rid && image.subagent === null).flatMap((image) => {
    const source = mediaSource(image.previewData ?? image.data);
    return source === undefined ? [] : [{ source, caption: image.caption ?? image.path.split(/[\\/]/).at(-1) ?? "Image" }];
  });
  const subagents = display.subagent === "off" ? [] : state.streams.filter((item) => item.rid === stream.rid && item.subagent !== null);
  const character_ = state.characters.find((item) => item.name === character);
  const blocks = replyBlocks(stream, saved);
  return <article className="message assistant streaming" aria-label={`${character}, responding`} aria-busy="true" data-role="assistant">
    <Avatar name={character} avatar={character_?.avatar} size={mobile ? 32 : 36} />
    <div className="message-main">
      <div className="message-meta"><span className="message-name">{character}</span><span className="responding">{stream.final ? "finishing…" : "responding…"}</span></div>
      <div className="message-body">
        {blocks.length === 0 ? <div className="typing" aria-label="Waiting for the response"><span /><span /><span /></div> : <MessageBody message={{ content: "", images: [], content_blocks: blocks }} display={display} openImage={openImage} live={!stream.final} embeds />}
        {images.length === 0 || display.images === "off" ? null : <div className="images">{images.map((image, index) => <ImageThumb key={index} source={image.source} caption={image.caption} open={openImage} />)}</div>}
        {subagents.map((item) => <SubagentChip key={item.key} stream={item} openImage={openImage} />)}
        {stream.previewLimited === true ? <p className="notice-inline">Showing the most recent part of a long response.</p> : null}
      </div>
    </div>
  </article>;
}

function EmptyConversation({ character, state }: { character: string; state: WorkspaceSnapshot }) {
  const info = state.characters.find((item) => item.name === character);
  return <div className="empty">
    <Avatar name={character} avatar={info?.avatar} size={56} />
    <p className="empty-title">{character}</p>
    <p className="empty-text">{state.previousSegment === null ? "No messages in this conversation yet." : "No messages in the current context yet."}</p>
  </div>;
}

function SegmentLink({ lead, segment, ready }: { lead: string; segment: SegmentSummary | null; ready: boolean }) {
  return <div className="segment-link">
    <div className="segment-link-text">
      <span className="segment-link-name">{lead} {segment === null ? "the current conversation" : segmentName(segment)}</span>
      {segment === null ? null : <span className="segment-link-detail">{segmentDetail(segment)}</span>}
    </div>
    {segment === null
      ? <button type="button" className="button" onClick={() => workspace.closeSegment()}>Back to current</button>
      : <button type="button" className="button ghost" disabled={!ready} onClick={() => perform(() => workspace.openSegment(segment.index))}>View</button>}
  </div>;
}

function ContextStart({ previous, ready }: { previous: SegmentSummary | null; ready: boolean }) {
  if (previous === null) return null;
  return <div className="segment-edge">
    <SegmentLink lead="Before this:" segment={previous} ready={ready} />
    <div className="divider context" role="separator">Context starts here</div>
  </div>;
}

function SegmentBanner({ view, state }: { view: SegmentView; state: WorkspaceSnapshot }) {
  const fresh = (state.messages.at(-1)?.msg_id ?? null) !== view.seenLive || state.streams.some((stream) => !stream.final && stream.subagent === null);
  return <div className="segment-banner" role="status">
    <Icon name="archive" size={16} />
    <div className="segment-banner-text">
      <span className="segment-banner-name">Viewing {segmentName(view.segment)}</span>
      <span className="segment-banner-detail">{segmentDetail(view.segment)}</span>
    </div>
    {fresh ? <span className="tag">new messages</span> : null}
    <button type="button" className="button" onClick={() => workspace.closeSegment()}>Back to current</button>
  </div>;
}

export function Transcript({ state, character, mobile }: { state: WorkspaceSnapshot; character: string; mobile: boolean }) {
  const display = useDisplay();
  const active = useActiveRequests();
  const view = state.segmentView;
  const ready = state.status === "ready";
  const busy = active.size > 0 || state.streams.some((stream) => !stream.final && stream.subagent === null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  const [image, setImage] = useState<{ source: string; caption: string }>();
  const anchor = useRef<{ height: number; top: number; first: string | undefined } | null>(null);
  const [loading, setLoading] = useState(false);
  const live = view === null;
  const streams = live ? visibleStreams(state.streams, state.messages, active) : [];
  const scope = { character: state.character, thread: state.thread };
  const replaced = live ? regenReplaces(state.messages, streams, conversation.pendingRegens(scope).length > 0).join("\n") : "";
  const visibleMessages = view?.messages ?? state.messages;
  const shown = useMemo(() => {
    if (replaced === "") return visibleMessages;
    const hidden = new Set(replaced.split("\n"));
    return visibleMessages.filter((message) => !hidden.has(message.msg_id));
  }, [replaced, visibleMessages]);
  const savedParts = streams.map((stream) => savedPart(shown, stream));
  const streaming = savedParts.flatMap((message) => message === undefined ? [] : [message.msg_id]).join("\n");
  const items = useMemo(() => {
    const merged = new Set(streaming.split("\n"));
    return transcriptItems(shown.filter((message) => !merged.has(message.msg_id)));
  }, [shown, streaming]);
  const lastUser = live ? state.messages.findLast((message) => message.role === "user")?.msg_id : undefined;
  const waiting = live && streams.length === 0 ? conversation.awaitingStream(scope) : undefined;
  const info = state.characters.find((item) => item.name === character);
  const compacting = !live || display.compaction === "off" ? null : compactionPhase(state.activity);
  const openImage = useCallback<OpenImage>((source, caption) => setImage({ source, caption }), []);
  const loadEarlier = () => {
    const node = scroller.current;
    if (node === null || loading || view === null || !view.hasEarlier || !ready) return;
    anchor.current = { height: node.scrollHeight, top: node.scrollTop, first: view.messages[0]?.msg_id };
    setLoading(true);
    perform(async () => { try { await workspace.loadEarlierInSegment(); } finally { setLoading(false); setTimeout(() => { anchor.current = null; }, 0); } });
  };
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const saved = anchor.current;
    if (saved !== null && saved.first !== visibleMessages[0]?.msg_id) {
      node.scrollTop = saved.top + (node.scrollHeight - saved.height);
      anchor.current = null;
      return;
    }
    if (follow.current) node.scrollTop = node.scrollHeight;
  }, [visibleMessages, state.streams, state.media]);
  const onScroll = () => {
    const node = scroller.current;
    if (node === null) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    follow.current = atBottom;
    setAway(!atBottom);
    if (node.scrollTop < 120 && view !== null && view.hasEarlier) loadEarlier();
  };
  const jump = () => {
    const node = scroller.current;
    if (node === null) return;
    follow.current = true; setAway(false);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };
  return <div className="transcript-wrap">
    {view === null ? null : <SegmentBanner view={view} state={state} />}
    <div className="transcript" ref={scroller} onScroll={onScroll} tabIndex={-1} role="log" aria-label={view === null ? `Conversation with ${character}` : `${segmentName(view.segment)} with ${character}`} aria-live="off">
      <div className="transcript-column">
        {view === null ? <ContextStart previous={state.previousSegment} ready={ready} />
          : view.hasEarlier ? <div className="load-earlier">{loading ? <Spinner label="Loading earlier messages" /> : <button type="button" className="button ghost" onClick={loadEarlier}>Load earlier messages</button>}</div>
            : view.previous === null ? <div className="divider" role="separator">Start of the conversation</div> : <SegmentLink lead="Before this:" segment={view.previous} ready={ready} />}
        {view === null && state.messages.length === 0 && streams.length === 0 && waiting === undefined ? ready ? <EmptyConversation character={character} state={state} /> : <div className="empty"><Spinner label="Loading conversation" /></div> : null}
        {items.map((item) => {
          switch (item.kind) {
            case "day": return <div key={item.key} className="divider" role="separator">{item.label}</div>;
            case "message": return <MessageRow key={item.key} message={item.message} character={character} avatar={info?.avatar} last={live && item.last && streams.length === 0 && waiting === undefined} lastUser={item.message.msg_id === lastUser}
              metadata={state.metadata[item.message.msg_id]} display={display} busy={busy} mobile={mobile} openImage={openImage} readOnly={!live} />;
          }
        })}
        {streams.map((stream, index) => <StreamingMessage key={stream.key} stream={stream} saved={savedParts[index]} character={character} state={state} openImage={openImage} mobile={mobile} />)}
        {waiting === undefined ? null : <StreamingMessage stream={liveTurn(waiting, waiting, null)} saved={undefined} character={character} state={state} openImage={openImage} mobile={mobile} />}
        {compacting === null ? null : <div className="divider context" role="status"><span className="spinner" aria-hidden="true" />{compacting}</div>}
        {view === null ? null : <SegmentLink lead="After this:" segment={view.next} ready={ready} />}
        {state.uncertain.map((item) => <div key={item.rid} className="notice-card" role="alert">
          <Icon name="alert" size={16} /><span>The connection dropped while a request was in flight. Shore keeps working on it, and this notice clears when it finishes.</span>
          <button type="button" className="button" onClick={() => navigate({ view: "settings", page: "diagnostics" })}>Review</button>
          <button type="button" className="button ghost" onClick={() => workspace.acknowledge(item.rid)}>Dismiss</button>
        </div>)}
      </div>
    </div>
    {away ? <button type="button" className="jump" onClick={jump}><Icon name="chevronDown" size={16} />Latest</button> : null}
    {image === undefined ? null : <Lightbox image={image} close={() => setImage(undefined)} />}
  </div>;
}
