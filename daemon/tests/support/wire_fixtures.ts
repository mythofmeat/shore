import type { ClientMessage } from "../../src/protocol/ClientMessage.ts";
import type { Message } from "../../src/protocol/Message.ts";
import type { ServerMessage } from "../../src/protocol/ServerMessage.ts";
import type { StreamMetadata } from "../../src/protocol/StreamMetadata.ts";

export const WIRE_FIXTURES_CAPTURE = "tests/handler_captures/wire_fixtures.json";

export const SERVER_FIXTURES = {
  server_hello: {
    "type": "hello",
    "v": 1,
    "server_name": "shore-daemon",
    "characters": [
      {
        "name": "alice"
      },
      {
        "name": "bob"
      }
    ]
  } satisfies ServerMessage,
  server_hello_with_avatar: {
    "type": "hello",
    "v": 1,
    "server_name": "shore-daemon",
    "characters": [
      {
        "name": "alice",
        "avatar": {
          "mime_type": "image/png",
          "data": "cG5n"
        }
      }
    ]
  } satisfies ServerMessage,
  history: {
    "type": "history",
    "messages": [
      {
        "msg_id": "m_001",
        "role": "user",
        "content": "Hello!",
        "images": [],
        "content_blocks": [],
        "timestamp": "2026-01-15T10:30:00Z"
      },
      {
        "msg_id": "m_002",
        "role": "assistant",
        "content": "Hi there!",
        "images": [
          {
            "path": "/img/wave.png",
            "caption": "waving"
          }
        ],
        "content_blocks": [],
        "alt_index": 0,
        "alt_count": 2,
        "timestamp": "2026-01-15T10:30:01Z"
      }
    ],
    "config": {
      "model": "claude-haiku-4-5-20251001"
    },
    "selected_character": "alice",
    "revision": 12
  } satisfies ServerMessage,
  shutdown: {
    "type": "shutdown"
  } satisfies ServerMessage,
  ping: {
    "type": "ping"
  } satisfies ServerMessage,
  command_output: {
    "type": "command_output",
    "rid": "cmd_01",
    "name": "list_conversations",
    "data": {
      "conversations": [
        {
          "id": "c1",
          "title": "Chat"
        }
      ]
    }
  } satisfies ServerMessage,
  error: {
    "type": "error",
    "rid": "msg_01",
    "code": "busy",
    "message": "Engine is currently processing another request"
  } satisfies ServerMessage,
  stream_start: {
    "type": "stream_start",
    "rid": "msg_01",
    "regen": false
  } satisfies ServerMessage,
  stream_chunk: {
    "type": "stream_chunk",
    "rid": "msg_01",
    "text": "Hello, how can I ",
    "content_type": "text"
  } satisfies ServerMessage,
  stream_chunk_thinking: {
    "type": "stream_chunk",
    "rid": "msg_01",
    "text": "Let me think about this...",
    "content_type": "thinking"
  } satisfies ServerMessage,
  stream_end: {
    "type": "stream_end",
    "rid": "msg_01",
    "msg_id": "m_assistant_01",
    "revision": 12,
    "content": "Hello, how can I help you today?",
    "metadata": {
      "tokens": {
        "input": 1234,
        "output": 567,
        "cache_read": 890,
        "cache_write": 12
      },
      "timing": {
        "total_ms": 2340,
        "ttft_ms": 450
      },
      "model": "claude-haiku-4-5-20251001"
    },
    "is_final": true
  } satisfies ServerMessage,
  phase: {
    "type": "phase",
    "rid": "msg_01",
    "phase": "thinking",
    "model": "claude-haiku-4-5-20251001"
  } satisfies ServerMessage,
  new_message: {
    "type": "new_message",
    "revision": 8,
    "character": "Alice",
    "origin": "autonomous",
    "msg_id": "m_auto_01",
    "role": "assistant",
    "content": "I noticed something interesting.",
    "images": [],
    "content_blocks": [],
    "timestamp": "2026-01-15T10:35:00Z"
  } satisfies ServerMessage,
  new_message_with_alts: {
    "type": "new_message",
    "revision": 9,
    "msg_id": "m_auto_02",
    "role": "assistant",
    "content": "Alternative response.",
    "images": [],
    "content_blocks": [],
    "alt_index": 1,
    "alt_count": 3,
    "timestamp": "2026-01-15T10:36:00Z"
  } satisfies ServerMessage,
  tool_call: {
    "type": "tool_call",
    "rid": "msg_01",
    "tool_id": "tc_001",
    "tool_name": "web_search",
    "input": {
      "query": "rust serde tutorial",
      "max_results": 5
    }
  } satisfies ServerMessage,
  tool_result: {
    "type": "tool_result",
    "rid": "msg_01",
    "tool_id": "tc_001",
    "tool_name": "web_search",
    "output": "Found 5 results for 'rust serde tutorial'",
    "is_error": false
  } satisfies ServerMessage,
  send_image: {
    "type": "send_image",
    "rid": "msg_01",
    "path": "/tmp/chart.png",
    "caption": "Monthly revenue chart"
  } satisfies ServerMessage,
  cache_warning: {
    "type": "cache_warning",
    "expected_tokens": 5000,
    "message": "Cache miss: context was evicted, re-processing 5000 tokens"
  } satisfies ServerMessage,
  usage_warning: {
    "type": "usage_warning",
    "rid": "msg_01",
    "budget": "daily total",
    "message": "Usage budget \"daily total\" reached 80% ($8.00/$10.00); resets at 2026-05-19 10:00 AM.",
    "current_cost": 8.0,
    "cost_limit": 10.0,
    "percent_used": 0.8,
    "crossed_warn_at": [
      0.8
    ],
    "period": "day",
    "period_start": "2026-05-18T00:00:00Z",
    "reset_at": "2026-05-19T00:00:00Z",
    "reset_at_display": "2026-05-19 10:00 AM"
  } satisfies ServerMessage,
  usage_warning_pace: {
    "type": "usage_warning",
    "rid": "msg_02",
    "budget": "weekly",
    "message": "Usage budget \"weekly\" day pace reached 100% ($2.50/$2.17); pace resets at 2026-05-22 06:00 AM.",
    "current_cost": 2.5,
    "cost_limit": 2.17,
    "percent_used": 1.15,
    "crossed_warn_at": [
      1.0
    ],
    "period": "day",
    "period_start": "2026-05-21T06:00:00Z",
    "reset_at": "2026-05-22T06:00:00Z",
    "reset_at_display": "2026-05-22 06:00 AM",
    "scope": "pace"
  } satisfies ServerMessage,
  config_warning: {
    "type": "config_warning",
    "path": "/home/u/.config/shore/characters/poppy/config.toml",
    "character": "poppy",
    "message": "invalid config for character \"poppy\": [chat].model: unknown model \"claud-opus\""
  } satisfies ServerMessage,
  config_warning_global: {
    "type": "config_warning",
    "path": "/home/u/.config/shore/config.toml",
    "message": "TOML parse error at line 12"
  } satisfies ServerMessage,
};

export const CLIENT_FIXTURES = {
  client_hello: {
    "type": "hello",
    "client_type": "tui",
    "client_name": "shore",
    "capabilities": [
      "streaming",
      "images"
    ]
  } satisfies ClientMessage,
  client_message: {
    "type": "message",
    "rid": "req_001",
    "text": "Tell me about Rust",
    "stream": true,
    "images": [
      "/tmp/screenshot.png"
    ]
  } satisfies ClientMessage,
  client_regen: {
    "type": "regen",
    "rid": "req_002",
    "stream": true
  } satisfies ClientMessage,
  client_command: {
    "type": "command",
    "rid": "req_003",
    "name": "switch_character",
    "args": {
      "character": "alice",
      "greeting": true
    }
  } satisfies ClientMessage,
};

export const MESSAGE_OBJECT_FIXTURE = {
  "msg_id": "m_100",
  "role": "assistant",
  "content": "Here is the analysis.",
  "images": [
    {
      "path": "/img/chart.png",
      "caption": "Revenue chart"
    },
    {
      "path": "/img/table.png"
    }
  ],
  "content_blocks": [],
  "alt_index": 2,
  "alt_count": 4,
  "timestamp": "2026-03-15T14:22:00Z"
} satisfies Message;

export const STREAM_METADATA_FIXTURE = {
  "tokens": {
    "input": 2048,
    "output": 1024,
    "cache_read": 512,
    "cache_write": 256
  },
  "timing": {
    "total_ms": 3500,
    "ttft_ms": 800
  },
  "model": "claude-sonnet-4-6"
} satisfies StreamMetadata;
