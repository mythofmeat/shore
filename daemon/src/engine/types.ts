export type Role = "user" | "assistant" | "system";

export type MessageOrigin = "user_input" | "assistant_reply" | "autonomous";

export interface ImageRef {
  path: string;
  caption?: string;
  data?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
      reasoning_details?: unknown[];
      reasoning_content?: string;
    }
  | { type: "tool_use"; id: string; name: string; input: unknown; input_error?: string }
  | { type: "redacted_thinking"; data: string }
  | {
      type: "tool_result";
      tool_use_id: string;
       content: string | ContentBlock[];
      is_error?: boolean;
    }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface MessageAlternative {
  content: string;
  images: ImageRef[];
  content_blocks: ContentBlock[];
  timestamp: string;
  provider_key?: string;
  model?: string;
  version?: string;
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
  provider_key?: string;
  model?: string;
  origin?: MessageOrigin;
  version?: string;
}
