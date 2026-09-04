import type { ContentBlock } from "../engine/types.ts";
import type { WireMessage } from "./types.ts";

export interface FoldedTurns {
  turns: WireMessage[];
  transientTail: number[];
}

export function foldInlineSystemMessagesWithTail(turns: readonly WireMessage[]): FoldedTurns {
  if (!turns.some((t) => t.role === "system")) {
    return { turns: [...turns], transientTail: turns.map(() => 0) };
  }

  const out: WireMessage[] = [];
  const transientTail: number[] = [];

  for (const turn of turns) {
    if (turn.role !== "system") {
      out.push(turn);
      transientTail.push(0);
      continue;
    }
    const text = turn.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const prev = out[out.length - 1];
    if (prev && prev.role === "user") {
      out[out.length - 1] = { ...prev, content: [...prev.content, { type: "text", text }] };
      transientTail[transientTail.length - 1] = (transientTail[transientTail.length - 1] ?? 0) + 1;
      continue;
    }
    out.push({ role: "user", content: [{ type: "text", text }] });
    transientTail.push(1);
  }
  return { turns: out, transientTail };
}

export function foldInlineSystemMessages(turns: readonly WireMessage[]): WireMessage[] {
  return foldInlineSystemMessagesWithTail(turns).turns;
}

export function translatesToAnthropic(model: string): boolean {
  return model.startsWith("anthropic/");
}
