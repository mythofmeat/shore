import { messageBreakpoints } from "../cache_placement.ts";

export const NANOGPT_PROVIDER = "nanogpt";

export const NANOGPT_BASE_URL = "https://nano-gpt.com/api/v1";

const FAILOVER_WOULD_DISCARD_THE_CACHED_PREFIX = true;

const SHORE_PLACES_ITS_OWN_BREAKPOINTS = true;

export type NanogptCacheTtl = "5m" | "1h";

export function nanogptCacheTtl(requested: string): NanogptCacheTtl {
  return requested === "1h" ? "1h" : "5m";
}

export interface NanogptPromptCaching {
  enabled: true;
  ttl: NanogptCacheTtl;
  stickyProvider: boolean;
  explicitCacheControl: boolean;
}

export interface NanogptCachingInputs {
  ttl: string;
}

export function nanogptPromptCaching(inputs: NanogptCachingInputs): NanogptPromptCaching {
  return {
    enabled: true,
    ttl: nanogptCacheTtl(inputs.ttl),
    stickyProvider: FAILOVER_WOULD_DISCARD_THE_CACHED_PREFIX,
    explicitCacheControl: SHORE_PLACES_ITS_OWN_BREAKPOINTS,
  };
}

type NanogptCacheControl = { type: "ephemeral" } | { type: "ephemeral"; ttl: "1h" };

interface TextBlock {
  type: "text";
  text: string;
  cache_control?: NanogptCacheControl;
}

interface WireMessage {
  role: string;
  content?: unknown;
}

export interface NanogptPlacement {
  requested: number;
  placed: number;
  droppedNoAnchor: number;
}

function markerFor(ttl: NanogptCacheTtl): NanogptCacheControl {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function isBlankText(block: TextBlock): boolean {
  return block.type === "text" && (block.text ?? "").trim() === "";
}

function markLastPersistedBlock(
  msg: WireMessage,
  cc: NanogptCacheControl,
  transientTrailing: number,
): boolean {
  if (typeof msg.content === "string") {
    if (msg.content.trim() === "" || transientTrailing > 0) return false;
    msg.content = [{ type: "text", text: msg.content, cache_control: cc }] satisfies TextBlock[];
    return true;
  }
  if (!Array.isArray(msg.content)) return false;

  for (let i = msg.content.length - 1 - transientTrailing; i >= 0; i--) {
    const block = msg.content[i] as TextBlock | undefined;
    if (block === undefined || isBlankText(block)) continue;
    block.cache_control = cc;
    return true;
  }
  return false;
}

function toPlacementTurn(msg: WireMessage): {
  role: "user" | "assistant" | "system";
  toolResultOnly: boolean;
} {
  const role = msg.role === "assistant" ? "assistant" : msg.role === "system" ? "system" : "user";
  return { role, toolResultOnly: msg.role === "tool" };
}

export function placeNanogptBreakpoints(
  messages: WireMessage[],
  ttl: NanogptCacheTtl,
  transientTail: readonly number[] = [],
): NanogptPlacement {
  const cc = markerFor(ttl);
  const result: NanogptPlacement = { requested: 0, placed: 0, droppedNoAnchor: 0 };

  const firstConversationIndex = messages.findIndex((m) => m.role !== "system");
  const systemSpanEnd = firstConversationIndex === -1 ? messages.length : firstConversationIndex;

  if (systemSpanEnd > 0) {
    result.requested += 1;
    const lastSystemMessage = messages[systemSpanEnd - 1];
    const landed =
      lastSystemMessage !== undefined &&
      markLastPersistedBlock(lastSystemMessage, cc, transientTail[systemSpanEnd - 1] ?? 0);
    if (landed) result.placed += 1;
    else result.droppedNoAnchor += 1;
  }

  const conversation = messages.slice(systemSpanEnd);
  const marked = new Set<number>();

  for (const anchor of messageBreakpoints(conversation.map(toPlacementTurn))) {
    result.requested += 1;
    let landed = false;
    for (let i = anchor; i >= 0; i--) {
      if (marked.has(i)) break;
      const msg = conversation[i];
      if (msg === undefined) continue;
      if (markLastPersistedBlock(msg, cc, transientTail[systemSpanEnd + i] ?? 0)) {
        marked.add(i);
        result.placed += 1;
        landed = true;
        break;
      }
    }
    if (!landed) result.droppedNoAnchor += 1;
  }

  return result;
}
