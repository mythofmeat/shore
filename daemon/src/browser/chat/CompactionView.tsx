import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RunningCompaction } from "../../protocol/RunningCompaction.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { navigate } from "../app/route.ts";
import { compactionWatch, errorText, useCompactionRecord, useDisplay } from "../app/state.ts";
import { Dialog, Spinner } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import { threadLabel } from "../sidebar/Sidebar.tsx";
import { MessageBody } from "./Message.tsx";
import { timeLabel } from "./transcript.ts";

const TRIGGERS: Record<RunningCompaction["trigger"], string> = { manual: "You started it", idle: "Started after idle time", turn: "Started after a reply", deep_archive: "Started by the deep archive" };

function useElapsed(from: string | null, until: string | null, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (from === null) return "";
  const end = until === null ? now : Date.parse(until);
  const seconds = Math.max(0, Math.round((end - Date.parse(from)) / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

function roundOf(phase: string | null): string | null {
  return phase === null ? null : /round (\d+)/.exec(phase)?.[1] ?? null;
}

export function CompactionChip({ state, open }: { state: WorkspaceSnapshot; open: () => void }) {
  const record = useCompactionRecord();
  const mine = record !== null && record.character === state.character ? record : null;
  const running = state.compaction !== null;
  const elapsed = useElapsed(state.compaction?.started_at ?? null, null, running);
  if (!running && mine === null) return null;
  const thread = state.threads.find((item) => item.id === state.compaction?.thread);
  const label = running ? `Compacting${thread === undefined || thread.id === state.thread ? "" : ` ${threadLabel(thread)}`}` : mine?.failed === true ? "Compaction failed" : "Compaction finished";
  return <button type="button" className={`compaction-chip ${running ? "running" : ""}`} title="Show the compaction" aria-label={`${label}. Show the compaction`} onClick={open}>
    {running ? <span className="spinner chip-spinner" aria-hidden="true" /> : <Icon name={mine?.failed === true ? "alert" : "check"} size={14} />}
    <span>{label}</span>{running ? <span className="compaction-elapsed">{elapsed}</span> : null}
  </button>;
}

export function CompactionDialog({ state, close }: { state: WorkspaceSnapshot; close: () => void }) {
  const display = useDisplay();
  const record = useCompactionRecord();
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const character = state.character ?? "";
  useEffect(() => { compactionWatch.open(character, state.compaction); }, [character]);
  useEffect(() => { if (state.compaction !== null) compactionWatch.describe(state.compaction); }, [state.compaction]);
  useLayoutEffect(() => {
    const node = log.current;
    if (node !== null && following.current) node.scrollTop = node.scrollHeight;
  }, [record?.blocks]);
  const elapsed = useElapsed(record?.startedAt ?? null, record?.endedAt ?? null, record?.running === true);
  if (record === null || record.character !== character) return <Dialog title="Compaction" close={close} wide><div className="settings-empty"><Spinner label="Loading the compaction" /></div></Dialog>;
  const thread = state.threads.find((item) => item.id === record.thread);
  const round = roundOf(record.phase);
  const stop = () => { compactionWatch.stop().catch((failure: unknown) => toasts.show(errorText(failure), "error")); };
  const facts: [string, string][] = [
    ...(record.thread === null ? [] : [["Thread", thread === undefined ? record.thread : threadLabel(thread)] as [string, string]]),
    ...(record.trigger === null ? [] : [["Trigger", TRIGGERS[record.trigger]] as [string, string]]),
    ...(record.turns === null ? [] : [["Compacting", `${String(record.turns)} ${record.turns === 1 ? "turn" : "turns"}${record.firstAt === null ? "" : `, from ${new Date(record.firstAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${timeLabel(record.firstAt)}`}${record.lastAt === null ? "" : ` to ${new Date(record.lastAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${timeLabel(record.lastAt)}`}`] as [string, string]]),
    ...(round === null ? [] : [["Round", round] as [string, string]]),
    ...(elapsed === "" ? [] : [[record.running ? "Running for" : "Took", elapsed] as [string, string]]),
  ];
  return <Dialog title="Compaction" close={close} wide footer={<>
    <button type="button" className="button ghost" onClick={() => { close(); navigate({ view: "settings", page: "traces" }); }}>Traces & call log</button>
    <span className="dialog-footer-gap" />
    {record.running ? <button type="button" className="button danger" disabled={record.stopping} onClick={stop}>{record.stopping ? "Stopping…" : "Stop"}</button> : <button type="button" className="button" onClick={() => { compactionWatch.dismiss(); close(); }}>Dismiss</button>}
    <button type="button" className="button primary" onClick={close}>Close</button>
  </>}>
    <dl className="compaction-facts">{facts.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
    {record.result === null ? null : <p className={record.failed ? "form-error" : "form-text"} role="status">{record.result}</p>}
    {record.interrupted ? <p className="form-text" role="status">Lost touch with the compaction. It carries on, and this view catches up when the connection is back.</p> : null}
    {record.limited ? <p className="notice-inline">Showing the most recent part of a long pass.</p> : null}
    <div className="compaction-log" ref={log} tabIndex={0} aria-label="What the compaction is doing" onScroll={(event) => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }}>
      {record.blocks.length === 0 ? record.running ? <div className="settings-empty"><Spinner label="Waiting for the compaction" /></div> : <p className="form-text">Nothing was recorded for this pass here. Its model calls are under Traces & call log.</p>
        : <MessageBody message={{ content: "", images: [], content_blocks: record.blocks }} display={{ ...display, thinking: "on", tools: "on", images: "off" }} openImage={() => {}} live={record.running} expanded />}
    </div>
  </Dialog>;
}
