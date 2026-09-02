import type { ContentBlock } from "../engine/types.ts";
import type { WireMessage } from "./types.ts";

export function foldInlineSystemMessages(turns: readonly WireMessage[]): WireMessage[] {
  if (!turns.some((t) => t.role === "system")) return [...turns];

  const out: WireMessage[] = [];
  for (const turn of turns) {
    if (turn.role !== "system") {
      out.push(turn);
      continue;
    }
    const text = turn.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const prev = out[out.length - 1];
    if (prev && prev.role === "user") {
      out[out.length - 1] = { ...prev, content: [...prev.content, { type: "text", text }] };
      continue;
    }
    out.push({ role: "user", content: [{ type: "text", text }] });
  }
  return out;
}

export function translatesToAnthropic(model: string): boolean {
  return model.startsWith("anthropic/");
}
