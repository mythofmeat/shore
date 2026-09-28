import type { ContentBlock } from "../../protocol/ContentBlock";
import type { ImageRef } from "../../protocol/ImageRef";
import type { ServerMessage } from "../../protocol/ServerMessage";

export interface PendingImage {
  readonly path: string;
  readonly caption: string | undefined;
  readonly data: string | undefined;
}

export type MirrorAction =
  | { readonly kind: "start_typing" }
  | { readonly kind: "stop_typing" }
  | {
      readonly kind: "post";
      readonly msgId: string | undefined;
      readonly replacesLast: boolean;
      readonly autonomous: boolean;
      readonly thinking: string | undefined;
      readonly text: string;
      readonly images: readonly PendingImage[];
    }
  | { readonly kind: "user_prompt"; readonly msgId: string | undefined; readonly content: string }
  | { readonly kind: "command_output"; readonly name: string; readonly data: unknown }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "none" };

const NONE: MirrorAction = { kind: "none" };

export function routeMirror(msg: ServerMessage): MirrorAction {
  switch (msg.type) {
    case "new_message": {
      const msgId = msg.msg_id === "" ? undefined : msg.msg_id;
      if (msg.origin === "user_input") {
        return { kind: "user_prompt", msgId, content: msg.content };
      }
      const altCount = msg.alt_count ?? msg.alternatives?.length ?? 0;
      return {
        kind: "post",
        msgId,
        replacesLast: msg.origin === "assistant_reply" && altCount >= 2,
        autonomous: msg.origin === "autonomous",
        thinking: extractThinking(msg.content_blocks),
        text: msg.content,
        images: pendingImages(msg.images),
      };
    }

    case "stream_start":
    case "stream_chunk":
      return { kind: "start_typing" };

    case "stream_end":
      return { kind: "stop_typing" };

    case "command_output":
      return { kind: "command_output", name: msg.name, data: msg.data };

    case "error":
      return { kind: "error", text: `${msg.code}: ${msg.message}` };

    case "usage_warning":
      return {
        kind: "notice",
        text:
          `⚠️ ${msg.message} — $${msg.current_cost.toFixed(2)} of ` +
          `$${msg.cost_limit.toFixed(2)} (${Math.round(msg.percent_used * 100)}%) this ${msg.period}`,
      };

    case "plan_limit_warning":
      return { kind: "notice", text: `⚠️ ${msg.message}` };

    case "provider_warning":
      return { kind: "notice", text: `⚠️ ${msg.message}` };

    case "cache_warning":
      return { kind: "notice", text: `⚠️ cache: ${msg.message}` };

    case "provider_fallback_warning": {
      const status = msg.status === undefined || msg.status === null ? "" : `, HTTP ${msg.status}`;
      return {
        kind: "notice",
        text:
          `⚠️ provider \`${msg.provider}\`: key **${msg.from_key}** failed ` +
          `(${msg.kind}${status}) — now using **${msg.to_key}**`,
      };
    }

    default:
      return NONE;
  }
}

export function extractThinking(blocks: readonly ContentBlock[]): string | undefined {
  const parts = blocks
    .filter((block): block is Extract<ContentBlock, { type: "thinking" }> => block.type === "thinking")
    .map((block) => block.thinking)
    .filter((thinking) => thinking.trim() !== "");
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

function pendingImages(images: readonly ImageRef[]): PendingImage[] {
  return images.map((image) => ({
    path: image.path,
    caption: image.caption ?? undefined,
    data: image.data ?? undefined,
  }));
}

export type ReactionControl = "regen" | "delete" | "alt_prev" | "alt_next";

const REACTIONS = new Map<string, ReactionControl>([
  ["🔁", "regen"],
  ["🔄", "regen"],
  ["🗑", "delete"],
  ["❌", "delete"],
  ["◀", "alt_prev"],
  ["⬅", "alt_prev"],
  ["▶", "alt_next"],
  ["➡", "alt_next"],
]);

const VARIATION_SELECTOR_16 = "\u{FE0F}";

export function parseReaction(key: string): ReactionControl | undefined {
  return REACTIONS.get(Array.from(key).filter((c) => c !== VARIATION_SELECTOR_16).join(""));
}

export function splitLines(content: string): string[] {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body === "" ? [] : body.split("\n");
}

export function formatUserMirror(content: string): string {
  const lines = splitLines(content);
  const first = lines.shift();
  if (first === undefined) return "> \u{1F464}";
  return [`> \u{1F464} ${first}`, ...lines.map((line) => `> ${line}`)].join("\n");
}
