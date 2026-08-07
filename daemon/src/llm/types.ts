import type { ContentBlock, ImageRef } from "../engine/types.ts";
import type { UsageConfig } from "../ledger/budget.ts";

export type Sdk =
  | "anthropic"
  | "openai"
  | "zai"
  | "gemini"
  | "openrouter"
  | "deepseek"
  | "moonshot";

export interface WireMessage {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  provider_key?: string;
  model?: string;
}

export type ThinkingReplay = "all" | "none";

export function toolResultText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

export interface SystemBlock {
  text: string;
  label: string;
}

export type SystemContent = SystemBlock[];

export function systemToText(system: SystemContent | undefined): string {
  if (system === undefined) return "";
  return system.map((b) => b.text).join("\n\n");
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const EMPTY_TOOL_SCHEMA: Record<string, unknown> = { type: "object" };

export interface ProviderOptions {
  reasoning_effort?: string;
  thinking_enabled?: boolean;
  budget_tokens?: number;
  cache_ttl?: string;
  openrouter_provider?: unknown;
  gemini_generation?: number;
  zai_clear_thinking?: boolean;
  zai_subscription?: boolean;
}

export interface CallContext {
  ledger?: string;
  character: string;
  call_type: string;
  api_key_name?: string;
  thinking_enabled: boolean;
  cache_ttl?: string;
  reasoning_effort?: string;
  keepalive_max_secs?: number;
  forensics_dir?: string;
  rid?: string;
  usage?: UsageConfig;
}

export interface SidecarRequest {
  sdk: Sdk;
  model: string;
  api_key: string;
  base_url?: string;
  messages: WireMessage[];
  system?: SystemContent;
  tools?: ToolDefinition[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  provider_options?: ProviderOptions;
  provider_key?: string;
  replay_prior_thinking: ThinkingReplay;
  context?: CallContext;
  max_tool_iterations?: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd?: number;
}

export interface Timing {
  total_ms: number;
  time_to_first_token_ms: number;
}

export type StreamEvent =
  | { type: "start"; model: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "reasoning_details"; details: unknown[] }
  | { type: "reasoning_content"; reasoning: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "done";
      content: string;
      finish_reason: string;
      content_blocks?: unknown[];
      usage: Usage;
      timing: Timing;
    }
  | {
      type: "call_complete";
      usage: Usage;
      timing: Timing;
      finish_reason: string;
      continuation: boolean;
    }
  | { type: "ping" }
  | {
      type: "error";
      message: string;
      usage: Usage;
      timing: Timing;
    };

export function streamErrorEvent(
  err: unknown,
  usage: Usage,
  startedAt: number,
  firstTokenAt: number,
  now: () => number,
): StreamEvent {
  return {
    type: "error",
    message: err instanceof Error ? err.message : String(err),
    usage,
    timing: {
      total_ms: now() - startedAt,
      time_to_first_token_ms: firstTokenAt === 0 ? 0 : firstTokenAt - startedAt,
    },
  };
}

export interface GenerateResponse {
  content: string;
  content_blocks: ContentBlock[];
  finish_reason: string;
  usage: Usage;
  timing: Timing;
  model: string;
}

export interface SidecarProvider {
  stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse>;
}

export interface ImageRequest {
  provider_key: string;
  model: string;
  api_key: string;
  base_url?: string;
  prompt: string;
  size?: string;
  quality?: string;
  aspect_ratio?: string;
  image_size?: string;
}

export interface ImageResponse {
  url: string;
  revised_prompt: string;
  timing: { total_ms: number };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TurnMessage {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  images?: ImageRef[];
}

export function toTurn(turn: WireMessage): TurnMessage {
  return { role: turn.role, content: turn.content };
}

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens?: number;
  effort?: string;
}

export interface SystemPromptBlock {
  type: "text";
  text: string;
  _label?: string;
}

export interface ChatRequest {
  system: string | SystemPromptBlock[];
  messages: TurnMessage[];
  tools: ToolDef[];
  thinking: ThinkingConfig;
  cacheTtl: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
  cacheForensics?: CacheForensicsSink;
  forensicCharacter?: string;
  forensicRid?: string;
}

export interface CacheForensicsSink {
  nextCallId(): number;
  logRequest(entry: {
    callId: number;
    character?: string;
    model: string;
    msgCount: number;
    msgBreakpoints: number[];
    sysBreakpoints: number[];
    sysBlocks: number;
    prefixHash: string;
    hasExistingMarkers: boolean;
    cacheEnabled: boolean;
    rid?: string;
  }): void;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type ChatEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_use_start"; id: string; name: string }
  | { kind: "tool_use_input_delta"; id: string; partial_json: string }
  | { kind: "tool_use_done"; id: string }
  | {
      kind: "done";
      content: ContentBlock[];
      stopReason: string;
      usage: UsageStats;
    };

export interface GenerateResult {
  content: ContentBlock[];
  stopReason: string;
  usage: UsageStats;
}

export interface ProviderClient {
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
  generate(req: ChatRequest): Promise<GenerateResult>;
}
