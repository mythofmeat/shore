import type { ContentBlock } from "../engine/types.ts";
import type { WireMessage } from "./types.ts";

export type ConversationTurn = WireMessage & { role: "user" | "assistant" };

export interface FoldedTurns {
  turns: ConversationTurn[];
  transientTail: number[];
}

function isConversationTurn(turn: WireMessage): turn is ConversationTurn {
  return turn.role !== "system";
}

export function foldInlineSystemMessagesWithTail(turns: readonly WireMessage[]): FoldedTurns {
  if (turns.every(isConversationTurn)) {
    return { turns: [...turns], transientTail: turns.map((turn) => turn.transient_tail ?? 0) };
  }

  const out: ConversationTurn[] = [];
  const transientTail: number[] = [];

  for (const turn of turns) {
    if (isConversationTurn(turn)) {
      out.push(turn);
      transientTail.push(turn.transient_tail ?? 0);
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

export function foldInlineSystemMessages(turns: readonly WireMessage[]): ConversationTurn[] {
  return foldInlineSystemMessagesWithTail(turns).turns;
}

export function translatesToAnthropic(model: string): boolean {
  return model.startsWith("anthropic/");
}
