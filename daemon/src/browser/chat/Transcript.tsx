import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LiveTurn, WorkspaceSnapshot } from "../workspace.ts";
import { mediaSource } from "../media.ts";
import { Avatar } from "../ui/avatar.tsx";
import { Dialog, Spinner } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { Markdown } from "../markdown.tsx";
import { conversation, perform, useActiveRequests, useDisplay, workspace } from "../app/state.ts";
import { navigate } from "../app/route.ts";
import { ImageThumb, MessageBody, MessageRow, ReasoningChip, type OpenImage } from "./Message.tsx";
import { compactionPhase, regenInFlight, regenStart, transcriptItems, visibleStreams } from "./transcript.ts";

function Lightbox({ image, close }: { image: { source: string; caption: string }; close: () => void }) {
  return <Dialog title={image.caption} close={close} wide>
    <img className="lightbox-image" src={image.source} alt={image.caption} />
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
      <MessageBody message={{ content: "", images: [], content_blocks: stream.blocks.filter((block) => block.type !== "text") }} display={display} openImage={openImage} live={!stream.final} />
      {stream.text === "" ? null : <Markdown text={stream.text} />}
    </Dialog> : null}
  </>;
}

function StreamingMessage({ stream, character, state, openImage, mobile }: { stream: LiveTurn; character: string; state: WorkspaceSnapshot; openImage: OpenImage; mobile: boolean }) {
  const display = useDisplay();
  const images = state.media.filter((image) => image.rid === stream.rid && image.subagent === null).flatMap((image) => {
    const source = mediaSource(image.previewData ?? image.data);
    return source === undefined ? [] : [{ source, caption: image.caption ?? image.path.split(/[\\/]/).at(-1) ?? "Image" }];
  });
  const subagents = display.subagent === "off" ? [] : state.streams.filter((item) => item.rid === stream.rid && item.subagent !== null);
  const character_ = state.characters.find((item) => item.name === character);
  const empty = stream.text === "" && stream.blocks.length === 0;
  return <article className="message assistant streaming" aria-label={`${character}, responding`} aria-busy="true" data-role="assistant">
    <Avatar name={character} avatar={character_?.avatar} size={mobile ? 32 : 36} />
    <div className="message-main">
      <div className="message-meta"><span className="message-name">{character}</span><span className="responding">{stream.final ? "finishing…" : "responding…"}</span></div>
      <div className="message-body">
        {stream.reasoning !== "" && display.thinking !== "off" ? <ReasoningChip text={stream.reasoning} live={stream.text === ""} /> : null}
        <MessageBody message={{ content: "", images: [], content_blocks: stream.blocks.filter((block) => block.type !== "text" && block.type !== "thinking" && block.type !== "redacted_thinking") }} display={display} openImage={openImage} live />
        {stream.text === "" ? null : <Markdown text={stream.text} className="prose streaming-text" />}
        {empty && stream.reasoning === "" ? <div className="typing" aria-label="Waiting for the response"><span /><span /><span /></div> : null}
        {images.length === 0 || display.images === "off" ? null : <div className="images">{images.map((image, index) => <ImageThumb key={index} source={image.source} caption={image.caption} open={openImage} />)}</div>}
        {subagents.map((item) => <SubagentChip key={item.key} stream={item} openImage={openImage} />)}
        {stream.previewLimited === true ? <p className="notice-inline">Showing the most recent part of a long response.</p> : null}
      </div>
    </div>
  </article>;
}

export function EmptyConversation({ character, state }: { character: string; state: WorkspaceSnapshot }) {
  const info = state.characters.find((item) => item.name === character);
  return <div className="empty">
    <Avatar name={character} avatar={info?.avatar} size={56} />
    <p className="empty-title">{character}</p>
    <p className="empty-text">No messages in this conversation yet.</p>
  </div>;
}

export function Transcript({ state, character, mobile }: { state: WorkspaceSnapshot; character: string; mobile: boolean }) {
  const display = useDisplay();
  const active = useActiveRequests();
  const busy = active.size > 0 || state.streams.some((stream) => !stream.final && stream.subagent === null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  const [image, setImage] = useState<{ source: string; caption: string }>();
  const anchor = useRef<{ height: number; top: number; first: string | undefined } | null>(null);
  const [loading, setLoading] = useState(false);
  const streams = visibleStreams(state.streams, state.messages, active);
  const scope = { character: state.character, thread: state.thread };
  const replacing = regenInFlight(streams, conversation.pendingRegens(scope), conversation.regens(scope));
  const shown = useMemo(() => replacing ? state.messages.slice(0, regenStart(state.messages, state.activeStart)) : state.messages, [replacing, state.messages, state.activeStart]);
  const items = useMemo(() => transcriptItems(shown, state.activeStart), [shown, state.activeStart]);
  const lastUser = state.messages.findLast((message) => message.role === "user")?.msg_id;
  const waiting = streams.length === 0 ? conversation.awaitingStream(scope) : undefined;
  const info = state.characters.find((item) => item.name === character);
  const compacting = display.compaction === "off" ? null : compactionPhase(state.activity);
  const openImage = useCallback<OpenImage>((source, caption) => setImage({ source, caption }), []);
  const loadEarlier = () => {
    const node = scroller.current;
    if (node === null || loading || !state.hasEarlier || state.status !== "ready") return;
    anchor.current = { height: node.scrollHeight, top: node.scrollTop, first: state.messages[0]?.msg_id };
    setLoading(true);
    perform(async () => { try { await workspace.loadEarlier(); } finally { setLoading(false); setTimeout(() => { anchor.current = null; }, 0); } });
  };
  const probed = useRef(false);
  useEffect(() => {
    if (probed.current || state.status !== "ready" || !state.hasEarlier || state.messages.length === 0) return;
    probed.current = true;
    loadEarlier();
  });
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const saved = anchor.current;
    if (saved !== null && saved.first !== state.messages[0]?.msg_id) {
      node.scrollTop = saved.top + (node.scrollHeight - saved.height);
      anchor.current = null;
      return;
    }
    if (follow.current) node.scrollTop = node.scrollHeight;
  }, [state.messages, state.streams, state.media]);
  const onScroll = () => {
    const node = scroller.current;
    if (node === null) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    follow.current = atBottom;
    setAway(!atBottom);
    if (node.scrollTop < 120 && state.hasEarlier && state.messages.length > 0) loadEarlier();
  };
  const jump = () => {
    const node = scroller.current;
    if (node === null) return;
    follow.current = true; setAway(false);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };
  return <div className="transcript-wrap">
    <div className="transcript" ref={scroller} onScroll={onScroll} tabIndex={-1} role="log" aria-label={`Conversation with ${character}`} aria-live="off">
      <div className="transcript-column">
        {state.hasEarlier && state.messages.length > 0 ? <div className="load-earlier">{loading ? <Spinner label="Loading earlier messages" /> : <button type="button" className="button ghost" onClick={loadEarlier}>Load earlier messages</button>}</div> : null}
        {state.messages.length === 0 && streams.length === 0 && waiting === undefined ? state.status === "ready" ? <EmptyConversation character={character} state={state} /> : <div className="empty"><Spinner label="Loading conversation" /></div> : null}
        {items.map((item) => {
          switch (item.kind) {
            case "day": return <div key={item.key} className="divider" role="separator">{item.label}</div>;
            case "context": return <div key={item.key} className="divider context" role="separator">Earlier messages aren’t in the active context</div>;
            case "message": return <MessageRow key={item.key} message={item.message} character={character} avatar={info?.avatar} last={item.last && streams.length === 0 && waiting === undefined} lastUser={item.message.msg_id === lastUser}
              metadata={state.metadata[item.message.msg_id]} display={display} busy={busy} mobile={mobile} openImage={openImage} />;
          }
        })}
        {streams.map((stream) => <StreamingMessage key={stream.key} stream={stream} character={character} state={state} openImage={openImage} mobile={mobile} />)}
        {waiting === undefined ? null : <StreamingMessage stream={{ key: waiting, rid: waiting, subagent: null, text: "", reasoning: "", blocks: [], final: false, msgId: null, metadata: null }} character={character} state={state} openImage={openImage} mobile={mobile} />}
        {compacting === null ? null : <div className="divider context" role="status"><span className="spinner" aria-hidden="true" />{compacting}</div>}
        {state.uncertain.map((item) => <div key={item.rid} className="notice-card" role="alert">
          <Icon name="alert" size={16} /><span>The connection dropped while a request was in flight. Check the conversation before trying again.</span>
          <button type="button" className="button" onClick={() => navigate({ view: "settings", page: "diagnostics" })}>Review</button>
          <button type="button" className="button ghost" onClick={() => workspace.acknowledge(item.rid)}>Dismiss</button>
        </div>)}
      </div>
    </div>
    {away ? <button type="button" className="jump" onClick={jump}><Icon name="chevronDown" size={16} />Latest</button> : null}
    {image === undefined ? null : <Lightbox image={image} close={() => setImage(undefined)} />}
  </div>;
}
