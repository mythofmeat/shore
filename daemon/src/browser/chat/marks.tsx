import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { AttemptMarks } from "../../protocol/AttemptMarks.ts";
import type { MarkKind } from "../../protocol/MarkKind.ts";
import type { MarkView } from "../../protocol/MarkView.ts";
import { plainOf } from "../../util/phrase.ts";
import { required } from "../../util/required.ts";
import { errorText, replyMarks } from "../app/state.ts";
import { IconButton } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import { wholeMark, type Editing, type ReplyKey } from "./reply_marks.ts";

export function useReplyMarks(): number {
  return useSyncExternalStore(replyMarks.subscribe, replyMarks.getSnapshot);
}

export function markScope(character: string | null, thread: string | null): string {
  return `${character ?? ""}/${thread ?? "main"}`;
}

export function reasonText(mark: Pick<MarkView, "tags" | "reason">): string {
  return [...mark.tags, ...(mark.reason === null ? [] : [mark.reason])].join("; ");
}

const VERB: Record<MarkKind, string> = { like: "Liked", dislike: "Disliked" };

function failed(error: unknown): void {
  toasts.show(errorText(error), "error");
}

export function MarkToggles({ message, scope, attempt, position, place = "row" }: { message: ReplyKey; scope: string; attempt: AttemptMarks | undefined; position: number; place?: Editing["place"] }) {
  const [busy, setBusy] = useState(false);
  const held = wholeMark(attempt);
  const press = (kind: MarkKind) => {
    setBusy(true);
    const work = held?.kind === kind
      ? replyMarks.unmark(scope, message, position, null)
      : replyMarks.mark(scope, message, position, { kind }).then(() => { replyMarks.edit({ ref: message.msg_id, position, phrase: null, place }); });
    void work.catch(failed).finally(() => setBusy(false));
  };
  return <span className="mark-toggles" role="group" aria-label={`Your mark on response ${String(position)}`}>
    <IconButton icon="like" size={15} className={`mark-toggle like${held?.kind === "like" ? " on" : ""}`} label={held?.kind === "like" ? "Liked; remove the like" : "Like"} aria-pressed={held?.kind === "like"} disabled={busy} onClick={() => press("like")} />
    <IconButton icon="dislike" size={15} className={`mark-toggle dislike${held?.kind === "dislike" ? " on" : ""}`} label={held?.kind === "dislike" ? "Disliked; remove the dislike" : "Dislike"} aria-pressed={held?.kind === "dislike"} disabled={busy} onClick={() => press("dislike")} />
  </span>;
}

export function MarkChips({ message, attempt, position, place = "row" }: { message: ReplyKey; attempt: AttemptMarks | undefined; position: number; place?: Editing["place"] }) {
  const marks = attempt?.marks ?? [];
  if (marks.length === 0) return null;
  return <div className="mark-chips">
    {marks.map((mark) => {
      const why = reasonText(mark);
      const what = mark.phrase === null ? VERB[mark.kind] : `“${mark.phrase}”`;
      return <button key={mark.phrase ?? ""} type="button" className={`mark-chip ${mark.kind}${mark.phrase === null ? " whole" : ""}`} title={why === "" ? "Add a reason" : why}
        aria-label={`${mark.phrase === null ? VERB[mark.kind] : `${VERB[mark.kind]} “${mark.phrase}”`}${why === "" ? "" : `: ${why}`}. Change`}
        onClick={() => replyMarks.edit({ ref: message.msg_id, position, phrase: mark.phrase, place })}>
        <Icon name={mark.kind} size={13} /><span className="mark-chip-what">{what}</span>{why === "" ? null : <span className="mark-chip-why">{why}</span>}
      </button>;
    })}
  </div>;
}

export function MarkEditor({ message, scope, editing, attempt }: { message: ReplyKey; scope: string; editing: Editing; attempt: AttemptMarks | undefined }) {
  const held = attempt?.marks.find((mark) => mark.phrase === editing.phrase);
  const [kind, setKind] = useState<MarkKind>(held?.kind ?? "like");
  const [tags, setTags] = useState<readonly string[]>(held?.tags ?? []);
  const [reason, setReason] = useState(held?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { area.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { void replyMarks.loadTags().catch(() => {}); }, []);
  const close = () => replyMarks.edit(null);
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().then(close).catch(failed).finally(() => setBusy(false));
  };
  const save = () => act(async () => await replyMarks.mark(scope, message, editing.position, { kind, ...(editing.phrase === null ? {} : { phrase: editing.phrase }), reason, tags }));
  const remove = () => act(async () => await replyMarks.unmark(scope, message, editing.position, editing.phrase));
  const toggle = (tag: string) => setTags(tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag]);
  const what = editing.phrase === null ? "this response" : `“${editing.phrase}”`;
  return <div className="mark-editor" role="group" aria-label={`Your mark on ${what}`} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
  }}>
    <div className="mark-editor-head">
      <span className="mark-editor-what">{editing.phrase === null ? "This response" : `“${editing.phrase}”`}</span>
      <span className="segmented" role="radiogroup" aria-label="Like or dislike">
        {(["like", "dislike"] as const).map((option) => <button key={option} type="button" role="radio" aria-checked={kind === option} onClick={() => setKind(option)}>
          <Icon name={option} size={14} />{option === "like" ? "Like" : "Dislike"}
        </button>)}
      </span>
    </div>
    {replyMarks.tags().length === 0 ? null : <div className="mark-tags" role="group" aria-label="Reasons">
      {replyMarks.tags().map((tag) => <button key={tag} type="button" className={`mark-tag ${tags.includes(tag) ? "on" : ""}`} aria-pressed={tags.includes(tag)} onClick={() => toggle(tag)}>{tag}</button>)}
    </div>}
    <textarea ref={area} className="input textarea mark-reason" rows={2} aria-label="Why, in your own words" placeholder="Why? (optional)" value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />
    <div className="edit-actions">
      {held === undefined ? null : <button type="button" className="button ghost" disabled={busy} onClick={remove}>Remove mark</button>}
      <span className="edit-hint">Esc to close · Ctrl+Enter to save</span>
      <button type="button" className="button" onClick={close}>Close</button>
      <button type="button" className="button primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
    </div>
  </div>;
}

export function RowMarkEditor({ message, scope, attempt, position }: { message: ReplyKey; scope: string; attempt: AttemptMarks | undefined; position: number }) {
  const editing = replyMarks.editing();
  const open = editing !== null && editing.place === "row" && editing.ref === message.msg_id && editing.position === position ? editing : null;
  return open === null ? null : <MarkEditor key={`${String(open.position)}:${open.phrase ?? ""}`} message={message} scope={scope} editing={open} attempt={attempt} />;
}

const blocks = "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,dt,dd";
const ranges = new Map<string, { like: Range[]; dislike: Range[] }>();

function repaint(): void {
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !("highlights" in CSS)) return;
  for (const kind of ["like", "dislike"] as const) {
    CSS.highlights.set(`shore-${kind}`, new Highlight(...[...ranges.values()].flatMap((found) => found[kind])));
  }
}

function textRanges(body: Element, marks: readonly MarkView[]): { like: Range[]; dislike: Range[] } {
  const found = { like: [] as Range[], dislike: [] as Range[] };
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  let block: Element | null = null;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest(".prose") === null) continue;
    const owner = node.parentElement?.closest(blocks) ?? null;
    if (block !== null && owner !== block) text += "\n";
    block = owner;
    nodes.push({ node: node as Text, start: text.length });
    text += (node as Text).data;
  }
  const plain = plainOf(text);
  const point = (index: number): [Text, number] => {
    const at = required(plain.at[index]);
    const holder = required(nodes.findLast((entry) => entry.start <= at));
    return [holder.node, at - holder.start];
  };
  for (const mark of marks) {
    if (mark.phrase === null) continue;
    const wanted = plainOf(mark.phrase).text;
    const start = plain.text.indexOf(wanted);
    if (wanted === "" || start === -1) continue;
    const range = document.createRange();
    range.setStart(...point(start));
    const [last, offset] = point(start + wanted.length - 1);
    range.setEnd(last, offset + 1);
    found[mark.kind].push(range);
  }
  return found;
}

export function usePhraseHighlights(key: string, body: RefObject<HTMLElement | null>, marks: readonly MarkView[]): void {
  useEffect(() => {
    const element = body.current;
    if (element === null) return;
    ranges.set(key, textRanges(element, marks));
    repaint();
    return () => { ranges.delete(key); repaint(); };
  });
}
