import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MarkKind } from "../../protocol/MarkKind.ts";
import { errorText, replyMarks, workspace } from "../app/state.ts";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import { markScope } from "./marks.tsx";
import { QUOTE_EVENT, QUOTE_SELECTION_EVENT } from "./quote.ts";
import { shownAttempt, type ReplyKey } from "./reply_marks.ts";

interface Spot { range: Range; top: number; left: number; reply: ReplyKey | undefined }

function replyOf(range: Range): ReplyKey | undefined {
  const article = messageBody(range.startContainer)?.closest("article.message[data-role=assistant]");
  if (!(article instanceof HTMLElement) || article.dataset["msgId"] === undefined) return undefined;
  return { msg_id: article.dataset["msgId"], alt_index: Number(article.dataset["altIndex"] ?? 0), alt_count: Number(article.dataset["altCount"] ?? 1) };
}

function markPhrase(reply: ReplyKey, kind: MarkKind, phrase: string): void {
  const state = workspace.getSnapshot();
  const scope = markScope(state.character, state.thread);
  const position = shownAttempt(replyMarks.attempts(reply))?.position ?? (reply.alt_index ?? 0) + 1;
  void replyMarks.mark(scope, reply, position, { kind, phrase }).then((changed) => {
    replyMarks.edit({ ref: reply.msg_id, position, phrase: changed.phrase, place: "row" });
  }).catch((error: unknown) => toasts.show(errorText(error), "error"));
}

function requestQuote(text: string): void {
  dispatchEvent(new CustomEvent<string>(QUOTE_EVENT, { detail: text }));
}

function messageBody(node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest(".message-body") ?? null;
}

function quotableSelection(selection: Selection | null): Range | undefined {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0).cloneRange();
  const first = messageBody(range.startContainer);
  const last = messageBody(range.endContainer);
  const body = first ?? last;
  if (body === null || (first !== null && last !== null && first !== last)) return undefined;
  if (first === null) range.setStart(body, 0);
  if (last === null) range.setEnd(body, body.childNodes.length);
  return range.toString().trim() === "" ? undefined : range;
}

function renderedText(selection: Selection, range: Range): string {
  selection.removeAllRanges();
  selection.addRange(range);
  const text = selection.toString();
  selection.removeAllRanges();
  return text;
}

function quoteSelection(): void {
  const selection = getSelection();
  if (selection === null) return;
  const range = quotableSelection(selection);
  requestQuote(range === undefined ? selection.toString() : renderedText(selection, range));
}

const GAP = 8;
const HEIGHT = 32;
const EDGE = 56;

function spotFor(range: Range): Spot {
  const rect = range.getBoundingClientRect();
  const below = rect.bottom + GAP;
  const top = below + HEIGHT > innerHeight ? Math.max(rect.top - GAP - HEIGHT, GAP) : below;
  return { range, top, left: Math.min(Math.max(rect.left + rect.width / 2, EDGE), innerWidth - EDGE), reply: replyOf(range) };
}

function onButton(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(".quote-selection") !== null;
}

export function QuoteButton() {
  const [spot, setSpot] = useState<Spot | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState(0);
  useLayoutEffect(() => {
    const rect = toolbar.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const over = rect.right - nudge - (innerWidth - GAP);
    const under = GAP - (rect.left - nudge);
    setNudge(over > 0 ? -over : under > 0 ? under : 0);
  }, [spot]);
  useEffect(() => {
    let pressed = false;
    const update = () => {
      const range = pressed ? undefined : quotableSelection(getSelection());
      setSpot(range === undefined ? null : spotFor(range));
    };
    const down = (event: PointerEvent) => { if (onButton(event)) return; pressed = true; setSpot(null); };
    const up = () => { if (!pressed) return; pressed = false; update(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setSpot(null); };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("keydown", key);
    addEventListener(QUOTE_SELECTION_EVENT, quoteSelection);
    addEventListener("scroll", update, true);
    addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("keydown", key);
      removeEventListener(QUOTE_SELECTION_EVENT, quoteSelection);
      removeEventListener("scroll", update, true);
      removeEventListener("resize", update);
    };
  }, []);
  if (spot === null) return null;
  const quote = () => {
    const selection = getSelection();
    setSpot(null);
    if (selection !== null) requestQuote(renderedText(selection, spot.range));
  };
  const quoteButton = <button type="button" className="quote-selection" style={spot.reply === undefined ? { top: spot.top, left: spot.left } : undefined}
    onPointerDown={(event) => { event.preventDefault(); quote(); }} onClick={quote}>
    <Icon name="quote" size={14} />Quote
  </button>;
  const reply = spot.reply;
  if (reply === undefined) return quoteButton;
  const mark = (kind: MarkKind) => {
    const selection = getSelection();
    setSpot(null);
    if (selection !== null) markPhrase(reply, kind, renderedText(selection, spot.range));
  };
  return <div ref={toolbar} className="quote-selection selection-actions" role="toolbar" aria-label="Selected words" style={{ top: spot.top, left: spot.left + nudge }}>
    {quoteButton}
    {(["like", "dislike"] as const).map((kind) => <button key={kind} type="button" className="quote-selection"
      onPointerDown={(event) => { event.preventDefault(); mark(kind); }} onClick={() => mark(kind)}>
      <Icon name={kind} size={14} />{kind === "like" ? "Like" : "Dislike"}
    </button>)}
  </div>;
}
