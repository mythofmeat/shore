/**
 * No provider credential reaches `calls.db`.
 *
 * The store is a forensics file: it outlives the key that made the calls, it is
 * what `shore log --api` and `shore diff` print, and it is the file a person
 * attaches to a bug report about a cache regression. Issue #72 is what it held
 * before this — `SidecarRequest.api_key` serialized whole into every internal
 * request row, and every `authorization` / `x-api-key` header value recorded
 * verbatim beside it.
 *
 * The masking is deliberately narrow. Header *names* stay, request bodies stay
 * byte-identical, and `api_key` keeps its place in the JSON — so nothing a
 * cache investigation reads has moved, and two calls made under different keys
 * still diff as identical rather than as a changed prefix.
 */

import { describe, expect, test } from "bun:test";

import { CallStore } from "../src/call_store.ts";
import { withCallCapture } from "../src/llm/capture.ts";
import { isCredentialHeader, redactHeaders, redactRequest, REDACTED } from "../src/llm/redact.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
} from "../src/llm/types.ts";

const SECRET = "sk-ant-api03-notarealkey";

function request(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-opus-4-6",
    provider_key: "anthropic",
    api_key: SECRET,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 64,
    replay_prior_thinking: "all",
    context: { character: "poppy", call_type: "message", thinking_enabled: false },
    ...overrides,
  } as SidecarRequest;
}

function provider(): SidecarProvider {
  const done: StreamEvent = {
    type: "done",
    content: "ok",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
    finish_reason: "end_turn",
  } as StreamEvent;
  return {
    async *stream() {
      yield done;
    },
    generate: () =>
      Promise.resolve({
        content: "ok",
        content_blocks: [{ type: "text", text: "ok" }],
        finish_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      } as unknown as GenerateResponse),
  };
}

describe("the header rule", () => {
  test("every scheme's credential header is caught, whatever its case", () => {
    for (const name of [
      "Authorization",
      "AUTHORIZATION",
      "proxy-authorization",
      "api-key",
      "x-api-key",
      "X-Api-Key",
      "x-api-token",
      "x-goog-api-key",
      "openai-api-key",
      "Cookie",
      "set-cookie",
    ]) {
      expect(isCredentialHeader(name)).toBe(true);
    }
  });

  test("the headers a cache investigation reads are left alone", () => {
    for (const name of [
      "content-type",
      "anthropic-beta",
      "anthropic-version",
      "user-agent",
      "x-request-id",
    ]) {
      expect(isCredentialHeader(name)).toBe(false);
    }
  });

  test("the name survives, only the value goes", () => {
    expect(
      redactHeaders([
        ["x-api-key", SECRET],
        ["anthropic-beta", "prompt-caching-2024-07-31"],
      ]),
    ).toEqual([
      ["x-api-key", REDACTED],
      ["anthropic-beta", "prompt-caching-2024-07-31"],
    ]);
  });
});

describe("the request rule", () => {
  test("the field keeps its place, so a key rotation is not a prompt diff", () => {
    const before = redactRequest(request({ api_key: "key-one" }));
    const after = redactRequest(request({ api_key: "key-two" }));

    expect(before.api_key).toBe(REDACTED);
    expect(JSON.stringify(before)).toBe(JSON.stringify(after));
  });

  test("everything else is untouched", () => {
    const original = request();
    const masked = redactRequest(original);

    expect(masked.messages).toEqual(original.messages);
    expect(masked.model).toBe(original.model);
    expect(masked.max_tokens).toBe(original.max_tokens);
    expect(original.api_key).toBe(SECRET);
  });

  test("an empty key is left as it is, not turned into a fake one", () => {
    // A provider that needs no key writes `""`. Masking it would claim a
    // credential was sent where none was.
    expect(redactRequest(request({ api_key: "" })).api_key).toBe("");
  });
});

describe("what lands on disk", () => {
  test("no row of a captured call carries the key", async () => {
    const store = CallStore.openInMemory();
    try {
      const captured = withCallCapture(provider(), store);
      for await (const _event of captured.stream(request())) {
        void _event;
      }

      const calls = store.queryCalls({ limit: 10 });
      expect(calls).toHaveLength(1);

      const payload = store.getCall(calls[0]!.id);
      expect(payload?.request).not.toContain(SECRET);
      expect(payload?.response ?? "").not.toContain(SECRET);
      expect(JSON.stringify(calls[0])).not.toContain(SECRET);
    } finally {
      store.close();
    }
  });
});
