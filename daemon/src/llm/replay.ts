import type { ContentBlock } from "../engine/types.ts";
import type { Sdk, SidecarRequest, WireMessage } from "./types.ts";

const ECHOES_UNSIGNED_THINKING: ReadonlySet<Sdk> = new Set<Sdk>([
  "openai",
  "zai",
  "deepseek",
  "moonshot",
]);

const REQUIRES_REASONING_REPLAY: ReadonlySet<string> = new Set(["moonshot", "moonshotai"]);

function carriesOpaqueData(block: ContentBlock): boolean {
  if (block.type === "redacted_thinking") return true;
  if (block.type !== "thinking") return false;
  return (
    block.signature !== undefined ||
    block.reasoning_details !== undefined ||
    block.reasoning_content !== undefined
  );
}

function hasForeignCarrier(block: ContentBlock): boolean {
  if (block.type !== "thinking") return false;
  return block.reasoning_details !== undefined || block.reasoning_content !== undefined;
}

function isPortable(
  block: ContentBlock,
  mintingProvider: string | undefined,
  mintingModel: string | undefined,
  activeProvider: string,
  activeModel: string,
): boolean {
  if (!carriesOpaqueData(block)) return true;

  if (hasForeignCarrier(block) && mintingModel !== activeModel) return false;

  if (mintingProvider !== undefined && mintingModel !== undefined) {
    return mintingProvider === activeProvider && mintingModel === activeModel;
  }
  if (mintingProvider !== undefined) {
    return mintingProvider === activeProvider;
  }
  if (block.type === "redacted_thinking" && block.data.startsWith("openrouter.reasoning:")) {
    return activeProvider.includes("openrouter");
  }
  return true;
}

function isThinking(block: ContentBlock): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

export interface ThinkingDrops {
  strippedByPolicy: number;
  unportable: number;
  uncarried: number;
}

export function replayableMessagesWithDrops(req: SidecarRequest): {
  messages: WireMessage[];
  drops: ThinkingDrops;
} {
  const activeProvider = req.provider_key ?? "";
  const activeModel = req.model;
  const keepsUncarried = ECHOES_UNSIGNED_THINKING.has(req.sdk);

  const stripPrior =
    req.replay_prior_thinking === "none" && !REQUIRES_REASONING_REPLAY.has(activeProvider);

  const drops: ThinkingDrops = { strippedByPolicy: 0, unportable: 0, uncarried: 0 };

  const out: WireMessage[] = [];
  for (const msg of req.messages) {
    const accompaniesToolUse =
      msg.role === "assistant" && msg.content.some((block) => block.type === "tool_use");

    const reason = thinkingDropReason(msg, {
      stripPrior: stripPrior && !accompaniesToolUse,
      keepsUncarried,
      activeProvider,
      activeModel,
    });

    const kept = msg.content.filter((block) => {
      if (block.type === "text" && block.text.trim() === "") return false;
      if (!isThinking(block)) return true;
      if (reason === undefined) return true;
      drops[reason] += 1;
      return false;
    });
    if (kept.length === 0) continue;
    out.push({ ...msg, content: kept });
  }
  return { messages: out, drops };
}

interface DropRules {
  stripPrior: boolean;
  keepsUncarried: boolean;
  activeProvider: string;
  activeModel: string;
}

function thinkingDropReason(msg: WireMessage, rules: DropRules): keyof ThinkingDrops | undefined {
  const thinking = msg.content.filter(isThinking);
  if (thinking.length === 0) return undefined;
  if (rules.stripPrior && msg.role === "assistant") return "strippedByPolicy";
  if (
    !rules.keepsUncarried &&
    thinking.some((block) => block.type === "thinking" && !carriesOpaqueData(block))
  ) {
    return "uncarried";
  }
  const portable = thinking.every((block) =>
    isPortable(block, msg.provider_key, msg.model, rules.activeProvider, rules.activeModel),
  );
  return portable ? undefined : "unportable";
}

export function totalThinkingDrops(drops: ThinkingDrops): number {
  return drops.strippedByPolicy + drops.unportable + drops.uncarried;
}

export function replayableMessages(req: SidecarRequest): WireMessage[] {
  const { messages, drops } = replayableMessagesWithDrops(req);

  if (req.context !== undefined) req.context.thinking_dropped = totalThinkingDrops(drops);

  if (drops.unportable > 0) {
    console.warn(
      `shore: ${String(drops.unportable)} thinking block(s) were minted by another ` +
        `provider or model and could not travel to ${req.provider_key ?? req.sdk}/${req.model}; ` +
        `the turn goes over the wire stripped`,
    );
  }
  return messages;
}
