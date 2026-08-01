/**
 * Wire-shape types mirroring `crates/common/src/protocol/types.rs`.
 *
 * `Message` is the canonical form post-normalize: `content` is always
 * present (derived from blocks or kept as-is for legacy data),
 * `images` and `content_blocks` arrays are always present (possibly
 * empty), and `alt_*` fields are present when the message has stored
 * alternatives.
 *
 * Serialization to JSON for the wire happens via `JSON.stringify` on
 * these objects directly; skip-if-empty / skip-if-none parity is handled
 * by omitting the field from the object rather than emitting `null`.
 */

export type Role = "user" | "assistant" | "system";

export interface ImageRef {
  path: string;
  caption?: string;
  /** Base64 image bytes, populated only for wire snapshots (not on disk). */
  data?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "thinking";
      thinking: string;
      /** Verbatim provider signature (Anthropic, Gemini `thoughtSignature`). */
      signature?: string;
      /** OpenRouter `reasoning_details`, replayed verbatim. */
      reasoning_details?: unknown[];
      /** Z.AI Preserved-Thinking `reasoning_content`, replayed verbatim. */
      reasoning_content?: string;
    }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "redacted_thinking"; data: string }
  | {
      type: "tool_result";
      tool_use_id: string;
      /** Usually text. The daemon's generated-image replay path returns blocks
       * (an image plus its caption); this was typed `string` for as long as it
       * existed, which was simply wrong for that path. */
       content: string | ContentBlock[];
      is_error?: boolean;
    }
  // Image blocks are not stored in Rust `ContentBlock`; the daemon synthesizes
  // them from a message's `images` and inlines them into the wire `content`
  // array (see `encode_image_block`), so the adapter must accept them here.
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface MessageAlternative {
  content: string;
  images: ImageRef[];
  content_blocks: ContentBlock[];
  timestamp: string;
  /** Provider that minted this alternative's content; see `Message.provider_key`. */
  provider_key?: string;
}

export interface Message {
  msg_id: string;
  role: Role;
  content: string;
  images: ImageRef[];
  content_blocks: ContentBlock[];
  alt_index?: number;
  alt_count?: number;
  alternatives?: MessageAlternative[];
  timestamp: string;
  /**
   * Provider key that minted this message's opaque thinking data. Carried for
   * wire-shape parity; the replay portability filter runs daemon-side.
   */
  provider_key?: string;
  /**
   * Model id that minted this message's content, in the ledger's vocabulary.
   * Finer-grained than `provider_key`, which an aggregator shares across many
   * model families — the replay guard needs both.
   */
  model?: string;
}
