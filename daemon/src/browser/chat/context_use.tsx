import { useEffect, useState } from "react";
import type { ThreadContextUse } from "../../protocol/ThreadContextUse.ts";
import type { ChromeSnapshot } from "../workspace.ts";
import { useConversationActive, workspace } from "../app/state.ts";

export function shortTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${String(Math.round(tokens / 1000))}k`;
}

export interface ContextLimit { name: string; value: string; fraction: number | undefined }

export function contextLimits(use: ThreadContextUse): ContextLimit[] {
  if (use.mode === "off") return [];
  const messages = { name: "Messages", value: `${shortTokens(use.message_tokens)} of ${shortTokens(use.trim_at)} tokens`, fraction: use.message_tokens / use.trim_at };
  if (use.mode === "trim") return [messages];
  const asked = use.context_tokens;
  return [
    ...(use.max_turns > 0 ? [{ name: "Turns", value: `${String(use.turns)} of ${String(use.max_turns)}`, fraction: use.turns / use.max_turns }] : []),
    ...(use.max_context_tokens > 0 ? [{
      name: "Everything sent last time",
      value: `${asked === undefined ? "?" : shortTokens(asked)} of ${shortTokens(use.max_context_tokens)} tokens`,
      fraction: asked === undefined ? undefined : asked / use.max_context_tokens,
    }] : []),
    messages,
  ];
}

function percentOf(fraction: number): number {
  return Math.min(100, Math.floor(fraction * 100));
}

export function contextPercent(use: ThreadContextUse): number | undefined {
  const fractions = contextLimits(use).flatMap((limit) => limit.fraction === undefined ? [] : [limit.fraction]);
  return fractions.length === 0 ? undefined : percentOf(Math.max(...fractions));
}

export function contextRule(use: ThreadContextUse): string {
  if (use.mode === "off") return "Compaction is off in the configuration, so older turns are never archived on their own.";
  if (use.mode === "trim") return "Older turns are archived only when the messages fill up.";
  return `Older turns are archived after the reply that reaches any of these.${use.min_turns > 1 ? ` Not before ${String(use.min_turns)} turns, unless the messages fill up.` : ""}`;
}

export function useContextUse(state: ChromeSnapshot): ThreadContextUse | undefined {
  const busy = useConversationActive({ character: state.character, thread: state.thread });
  const lastActive = state.threads.find((thread) => thread.id === state.thread)?.last_active;
  const [use, setUse] = useState<ThreadContextUse>();
  useEffect(() => {
    if (busy || state.status !== "ready") return;
    workspace.actions.run("context_use", {}).then(setUse, () => {});
  }, [busy, state.status, state.character, state.thread, lastActive]);
  return use?.thread === state.thread ? use : undefined;
}

function Bar({ percent }: { percent: number }) {
  return <span className="budget-chip-bar" aria-hidden="true"><span style={{ width: `${String(percent)}%` }} /></span>;
}

export function ContextChip({ state, open }: { state: ChromeSnapshot; open: () => void }) {
  const use = useContextUse(state);
  const percent = use === undefined ? undefined : contextPercent(use);
  if (percent === undefined) return null;
  return <button type="button" className="budget-chip" title={`${String(percent)}% of the way to archiving older turns`} onClick={open}>
    <Bar percent={percent} />
    <span>Context {percent}%</span>
  </button>;
}

export function ContextLimits({ state }: { state: ChromeSnapshot }) {
  const use = useContextUse(state);
  if (use === undefined) return null;
  const limits = contextLimits(use);
  return <div className="context-limits">
    <p className="form-text">{contextRule(use)}</p>
    {limits.length === 0 ? null : <dl className="context-limit-list">
      {limits.map((limit) => <div key={limit.name} className="context-limit">
        <dt>{limit.name}</dt>
        <dd><span>{limit.value}</span><Bar percent={limit.fraction === undefined ? 0 : percentOf(limit.fraction)} /></dd>
      </div>)}
    </dl>}
  </div>;
}
