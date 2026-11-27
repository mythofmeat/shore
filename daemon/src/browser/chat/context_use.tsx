import { useEffect, useState } from "react";
import type { ThreadContextUse } from "../../protocol/ThreadContextUse.ts";
import type { ChromeSnapshot } from "../workspace.ts";
import { useConversationActive, workspace } from "../app/state.ts";

export function shortTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${String(Math.round(tokens / 1000))}k`;
}

export function contextLine(use: ThreadContextUse): { text: string; title: string } {
  const messages = `${shortTokens(use.message_tokens)} of ${shortTokens(use.trim_at)} tokens of messages`;
  if (use.mode === "trim") return { text: `Next trim: ${messages}`, title: `Older turns are archived once the messages reach ${String(use.trim_at)} tokens; they are ${String(use.message_tokens)} now.` };
  if (use.mode === "off") return { text: "Compaction is off", title: "Compaction is off in the configuration, so this thread is never compacted." };
  const asked = use.context_tokens;
  const limits = [
    ...(use.max_turns > 0 ? [`${String(use.turns)} of ${String(use.max_turns)} turns`] : []),
    ...(use.max_context_tokens > 0 ? [`${asked === undefined ? "?" : shortTokens(asked)} of ${shortTokens(use.max_context_tokens)} tokens`] : []),
    messages,
  ];
  const reasons = [
    ...(use.max_turns > 0 ? [`it reaches ${String(use.max_turns)} turns (${String(use.turns)} now)`] : []),
    ...(use.max_context_tokens > 0 ? [`a request's whole input reaches ${String(use.max_context_tokens)} tokens (${asked === undefined ? "not known until the next reply" : `${String(asked)} last time`})`] : []),
    `its messages reach ${String(use.trim_at)} tokens (${String(use.message_tokens)} now)`,
  ];
  return { text: `Next compaction: ${limits.join(" · ")}`, title: `Compacts after a reply once ${reasons.join(", or ")}, and not before ${String(use.min_turns)} turns.` };
}

export function ContextUse({ state }: { state: ChromeSnapshot }) {
  const busy = useConversationActive({ character: state.character, thread: state.thread });
  const lastActive = state.threads.find((thread) => thread.id === state.thread)?.last_active;
  const [use, setUse] = useState<ThreadContextUse>();
  useEffect(() => {
    if (busy || state.status !== "ready") return;
    workspace.actions.run("context_use", {}).then(setUse, () => {});
  }, [busy, state.status, state.character, state.thread, lastActive]);
  if (use === undefined || use.thread !== state.thread) return null;
  const line = contextLine(use);
  return <p className="context-use" title={line.title}>{line.text}</p>;
}
