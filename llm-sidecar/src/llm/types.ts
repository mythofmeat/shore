/**
 * Sidecar IPC contract + internal adapter types.
 *
 * The CONTRACT section mirrors the Rust wire types 1:1 (see
 * `crates/daemon/src/llm/types.rs` and `docs/LLM_SIDECAR_IPC.md`). The Rust daemon
 * serializes an `LlmRequest` to `SidecarRequest`; the sidecar streams
 * `StreamEvent` NDJSON back, which `StreamConsumer` (`crates/daemon/src/llm/stream.rs`)
 * already knows how to parse. Field names are snake_case to match serde.
 *
 * The LEGACY section below holds the pre-migration adapter shapes
 * (`ChatRequest`/`ChatEvent`/...). The adapters still speak these; they move to
 * the contract types in the adapter-reshape task. Don't add new callers.
 *
 * Anthropic-style content blocks are the canonical in-process representation
 * because our on-disk format stores blocks this way and Anthropic is the picky
 * one about block ordering. The `thinking` block's `signature` is opaque bytes
 * replayed verbatim — never inspected, regenerated, or normalized.
 */

import type { ContentBlock, ImageRef } from "../engine/types.ts";

// ─────────────────────────────────────────────────────────────────────────
// CONTRACT — mirrors crates/daemon/src/llm/types.rs (the Rust↔sidecar wire)
// ─────────────────────────────────────────────────────────────────────────

/** Which SDK/dialect to use. Serializes lowercase, matching Rust `Sdk`.
 *
 * `openrouter` routes through OpenRouter's first-party SDK (the normalized path
 * for non-Anthropic providers); `openai`/`zai` are the DIRECT-to-vendor adapters
 * (native OpenAI, and Z.ai's subscription base URLs) — the daemon's per-provider
 * config decides which to send. */
export type Sdk =
  | "anthropic"
  | "openai"
  | "zai"
  | "gemini"
  | "openrouter"
  | "deepseek"
  | "moonshot";

/** One conversation turn as the daemon stores it: canonical Anthropic-shape
 * blocks (or a bare string for legacy/simple turns). The sidecar's per-SDK
 * adapter converts these to that provider's wire shape. */
export interface WireMessage {
  role: "user" | "assistant" | "system";
  content: ContentBlock[] | string;
}

/** System prompt: structured text blocks (Anthropic keeps them separate;
 * OpenAI gets them joined) or a bare string. */
export type SystemContent =
  | string
  | Array<{ type: "text"; text: string; cache_control?: unknown; _label?: string }>;

/**
 * One tool offered to the model, mirroring Rust `ToolDefinition`
 * (`crates/daemon/src/llm/types.rs`).
 *
 * The field names are Anthropic's spelling because that is what the daemon has
 * always emitted, but this is a provider-*neutral* shape: each adapter maps it
 * to its own wire format. Do not pass it to a provider unchanged outside the
 * Anthropic adapter.
 *
 * Order is significant — it is part of Anthropic's cache prefix — so adapters
 * must forward the array in the order received.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments; always an object schema. */
  input_schema: Record<string, unknown>;
}

/** The parameters-schema fallback for a tool that arrives without one.
 *
 * Anthropic previously defaulted to `{type:"object"}` here while the other five
 * adapters defaulted to `{}` — which OpenAI and Gemini reject as a function
 * parameters schema. One default, valid everywhere. */
export const EMPTY_TOOL_SCHEMA: Record<string, unknown> = { type: "object" };

/**
 * Per-provider knobs, mirroring Rust `ProviderOptions`
 * (`crates/daemon/src/llm/types.rs`). The two must change together.
 *
 * This was `Record<string, unknown>` on both sides until it accumulated three
 * keys the daemon wrote and no adapter read. Every field below has a reader in
 * this directory; adding one without a reader is now a type error at the
 * daemon's build, not a silent no-op at runtime.
 *
 * Absent knobs are omitted by the daemon rather than sent as null, so
 * `undefined` unambiguously means "not configured".
 */
export interface ProviderOptions {
  /** Named effort (`low`/`medium`/`high`/`max`/`adaptive`) or a provider-specific
   * string. Never `"off"` — the daemon rewrites that to `thinking_enabled: false`. */
  reasoning_effort?: string;
  /** Only ever `false`, meaning "explicitly disable reasoning". Adapters that can
   * turn thinking off on an always-on model act on it; the rest omit reasoning. */
  thinking_enabled?: boolean;
  /** Explicit thinking-token budget. */
  budget_tokens?: number;
  /** Prompt-cache TTL (`"5m"` / `"1h"`). Anthropic-only. */
  cache_ttl?: string;
  /** OpenRouter routing preferences, passed through verbatim as `provider`.
   * Genuinely opaque: OpenRouter's schema, authored by the user in models.toml. */
  openrouter_provider?: unknown;
  /** Manual Gemini generation override; absent means detect from the model id. */
  gemini_generation?: number;
  /** Z.ai `clear_thinking`. `false` is load-bearing — it enables the
   * Preserved-Thinking replay path — so this is a tri-state, not a flag. */
  zai_clear_thinking?: boolean;
  /** Route to Z.ai's coding-subscription base URL instead of the pay-go one. */
  zai_subscription?: boolean;
}

/**
 * The request the sidecar receives — the serialized Rust `LlmRequest` minus its
 * `#[serde(skip)]` transient fields (`api_key_name`, `rid`, `forensic_character`,
 * `retain_long`), which stay Rust-side.
 */
export interface SidecarRequest {
  sdk: Sdk;
  model: string;
  /** Bearer credential; adapter applies x-api-key vs Authorization. */
  api_key: string;
  /** Provider base URL override (e.g. OpenRouter, Z.ai). */
  base_url?: string;
  /** Conversation, already assembled into canonical blocks by the daemon. */
  messages: WireMessage[];
  system?: SystemContent;
  /** Tool surface in offer order. See {@link ToolDefinition}. */
  tools?: ToolDefinition[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  /** Per-provider knobs. See {@link ProviderOptions}. */
  provider_options?: ProviderOptions;
  /** models.toml provider key (e.g. "openrouter", "deepseek", "zai"). */
  provider_key?: string;
}

/** Token usage — mirrors Rust `Usage` (snake_case, cache fields default 0). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Provider-reported total cost when available (OpenRouter `cost`). */
  total_cost_usd?: number;
}

/** Timing — mirrors Rust `Timing`. */
export interface Timing {
  total_ms: number;
  time_to_first_token_ms: number;
}

/**
 * The NDJSON event vocabulary the daemon's `StreamConsumer` consumes.
 * Mirrors Rust `StreamEvent` (`#[serde(tag = "type", rename_all = "snake_case")]`).
 * Ordering rules live in `docs/LLM_SIDECAR_IPC.md`.
 */
export type StreamEvent =
  | { type: "start"; model: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  // Three unrelated payloads used to share `thinking_signature` behind a string
  // prefix (`orrd:`, `zair:`), so every adapter sniffed for its own. They are
  // siblings now: only the first is actually a signature.
  | { type: "thinking_signature"; signature: string }
  | { type: "reasoning_details"; details: unknown[] }
  | { type: "reasoning_content"; reasoning: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "done";
      content: string;
      finish_reason: string;
      usage: Usage;
      timing: Timing;
    }
  // A no-op keepalive emitted during quiet stretches (a long max-effort
  // thinking turn sends only provider `ping`s, which we do not forward). Its
  // sole purpose is to keep bytes flowing on the daemon↔sidecar socket so the
  // transport idle timeout cannot fire mid-stream. The consumer ignores it.
  | { type: "ping" }
  | {
      // A mid-stream provider failure. Carries whatever usage was accumulated
      // before the error (e.g. Anthropic reports the cache write in
      // `message_start`, before any output) so the daemon records the
      // already-billed tokens instead of zeros. The consumer turns this into
      // `LlmError::StreamErrored` and still fails the call so retry runs.
      type: "error";
      message: string;
      usage: Usage;
      timing: Timing;
    };

/**
 * Build the terminal `error` frame for a stream that threw mid-flight. Carries
 * the usage accumulated so far so the daemon records already-billed tokens —
 * notably the Anthropic cache write announced in `message_start`, before any
 * output — instead of zeros. Provider stream generators yield this from a
 * `catch` around their event loop, then return.
 */
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

/** Non-streaming result — mirrors Rust `GenerateResponse`. */
export interface GenerateResponse {
  content: string;
  content_blocks: ContentBlock[];
  finish_reason: string;
  usage: Usage;
  timing: Timing;
  model: string;
}

/**
 * A reshaped provider adapter: consumes a `SidecarRequest`, streams
 * `StreamEvent`s (or returns a `GenerateResponse`). `signal` mirrors the
 * connection-close cancellation the server forwards from the daemon.
 */
export interface SidecarProvider {
  stream(req: SidecarRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  generate(req: SidecarRequest, signal?: AbortSignal): Promise<GenerateResponse>;
}

/** Request for `POST /v1/image` — mirrors Rust `ImageGenerateParams`. */
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

/** Response for `POST /v1/image` — mirrors Rust `ImageGenerateResponse`. */
export interface ImageResponse {
  url: string;
  revised_prompt: string;
  timing: { total_ms: number };
}

// ─────────────────────────────────────────────────────────────────────────
// LEGACY — pre-migration adapter shapes. Replaced by the CONTRACT types when
// the adapters are reshaped to consume SidecarRequest / emit StreamEvent.
// ─────────────────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

/** One turn in the message array sent to the provider. */
export interface TurnMessage {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  /** Images to prepend to the turn's content when building the request. */
  images?: ImageRef[];
}

export interface ThinkingConfig {
  /** When false, request goes out without any thinking config. */
  enabled: boolean;
  /** Anthropic budget_tokens (when reasoning_effort is not "adaptive"). */
  budgetTokens?: number;
  /** Anthropic reasoning_effort: low | medium | high | xhigh | max | adaptive. */
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
  /** Empty string disables caching; otherwise a TTL like "1h" / "5m". */
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
