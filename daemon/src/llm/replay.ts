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

export function replayableMessages(req: SidecarRequest): WireMessage[] {
  const activeProvider = req.provider_key ?? "";
  const activeModel = req.model;
  const keepsUncarried = ECHOES_UNSIGNED_THINKING.has(req.sdk);

  const stripPrior =
    req.replay_prior_thinking === "none" && !REQUIRES_REASONING_REPLAY.has(activeProvider);

  const out: WireMessage[] = [];
  for (const msg of req.messages) {
    const kept = msg.content.filter((block) => {
      if (block.type === "text" && block.text.trim() === "") return false;
      if (!isThinking(block)) return true;
      if (stripPrior && msg.role === "assistant") return false;
      if (block.type === "thinking" && !carriesOpaqueData(block) && !keepsUncarried) return false;
      return isPortable(block, msg.provider_key, msg.model, activeProvider, activeModel);
    });
    if (kept.length === 0) continue;
    out.push({ ...msg, content: kept });
  }
  return out;
}
