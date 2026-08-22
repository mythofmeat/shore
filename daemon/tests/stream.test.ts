import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import rawStreamFixture from "./handler_fixtures/stream.json" with { type: "json" };
import { expandShared } from "./support/shared_subtrees.ts";
const fixture = expandShared(rawStreamFixture);

import { ConfigDuration } from "../src/config/duration.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import type { PendingAlt } from "../src/engine/message_store.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import {
  consumeStream,
  emitStreamEnd,
  StreamAccumulator,
  type FrameSink,
  type StreamResult,
} from "../src/llm/stream.ts";
import type { StreamEvent, Usage } from "../src/llm/types.ts";
import {
  appendResponseMessagesToRequest,
  applyGeneratedMessagesToEngine,
  completedResponseMessages,
  contentBlocksForResult,
  lastRequestWithResponse,
  messageFromResponse,
  notifyContentFromResponseMessages,
  persistAndNotify,
  type CompletedResponseMessage,
  type PersistContext,
  type PersistEngine,
  type WireRequest,
} from "../src/handler/persistence.ts";
import {
  defaultNotificationEvents,
  defaultNotificationsConfig,
  parseAppConfig,
  type NotificationsConfig,
} from "../src/config/app.ts";
import {
  NotificationService,
  ntfyUrl,
  renderCommandTemplate,
  shellEscape,
  truncateSummary,
  type NotificationEvent,
  type NotificationSink,
} from "../src/notifications.ts";

import { pathsSetBy, replayOntoCurrentDefaults } from "./config_delta.ts";

type Row = Record<string, unknown>;

const f = fixture as Record<string, Row[]> & { append_in_place: Row };

describe("truncate_summary", () => {
  for (const c of f["truncate_summary"] as Row[]) {
    const input = c["input"] as string;
    const max = c["max"] as number;
    test(`${JSON.stringify(input).slice(0, 40)} @ ${max}`, () => {
      expect(truncateSummary(input, max)).toBe(c["output"] as string);
    });
  }

  test("the cap is bytes, not characters", () => {
    const body = "🎵".repeat(100);
    expect(body.length).toBe(200);
    expect(truncateSummary(body, 200)).not.toBe(body);
    expect(truncateSummary(body, 200).endsWith("…")).toBe(true);
  });
});

describe("shell_escape", () => {
  for (const c of f["shell_escape"] as Row[]) {
    const input = c["input"] as string;
    test(JSON.stringify(input), () => {
      expect(shellEscape(input)).toBe(c["output"] as string);
    });
  }

  test("every occurrence is replaced, not just the first", () => {
    expect(shellEscape("`a`b`")).toBe("ab");
    expect(shellEscape("'a'b'")).toBe("'\\''a'\\''b'\\''");
  });

  test("shell operators survive — the template supplies the quoting", () => {
    expect(shellEscape("; rm -rf / & id | cat")).toBe("; rm -rf / & id | cat");
  });
});

describe("command_template", () => {
  for (const c of f["command_template"] as Row[]) {
    test(c["template"] as string, () => {
      expect(
        renderCommandTemplate(c["template"] as string, c["title"] as string, c["body"] as string),
      ).toBe(c["rendered"] as string);
    });
  }
});

function configWith(overrides: Partial<NotificationsConfig>): NotificationsConfig {
  return { ...defaultNotificationsConfig(), ...overrides };
}

describe("notification gating", () => {
  for (const group of f["gating"] as Row[]) {
    const enabled = group["enabled"] as boolean;
    const events = group["events"] as Row[];
    describe(group["name"] as string, () => {
      const eventsConfig = Object.fromEntries(
        events.map((e) => [e["event"] as string, e["event_enabled"] as boolean]),
      ) as unknown as NotificationsConfig["events"];
      const svc = new NotificationService(configWith({ enabled, events: eventsConfig }));

      for (const e of events) {
        const name = e["event"] as NotificationEvent;
        test(`${name} enabled`, () => {
          expect(svc.isEventEnabled(name)).toBe(e["event_enabled"] as boolean);
        });
        test(`${name} dispatches`, () => {
          expect(svc.shouldNotify(name)).toBe(e["would_notify"] as boolean);
        });
      }
    });
  }

  test("a disabled service dispatches nothing", () => {
    const sent: string[] = [];
    const sink = recordingSink(sent);
    const svc = new NotificationService(configWith({ enabled: false }), sink);
    svc.notify("error", "t", "b");
    expect(sent).toEqual([]);
  });

  test("an enabled service dispatches through the configured backend", async () => {
    const sent: string[] = [];
    const svc = new NotificationService(
      configWith({
        enabled: true,
        backend: "ntfy",
        ntfy: { url: "u", topic: "t", token: "" },
        events: { ...defaultNotificationEvents(), error: true },
      }),
      recordingSink(sent),
    );
    svc.notify("error", "title", "body");
    await Promise.resolve();
    expect(sent).toEqual(["ntfy:title:body"]);
  });

  test("the body is truncated to 200 bytes, the title is not", async () => {
    const sent: string[] = [];
    const svc = new NotificationService(
      configWith({ enabled: true, events: { ...defaultNotificationsConfig().events, error: true } }),
      recordingSink(sent),
    );
    const longTitle = "T".repeat(500);
    svc.notify("error", longTitle, "b".repeat(500));
    await Promise.resolve();
    const [line] = sent;
    expect(line).toBeDefined();
    const [, title, body] = (line as string).split(":");
    expect(title).toBe(longTitle);
    expect(body).toBe(`${"b".repeat(200)}…`);
  });

  test("a dispatch failure is swallowed, not raised", async () => {
    const svc = new NotificationService(configWith({ enabled: true }), {
      notifySend: () => Promise.reject(new Error("no notify-send")),
      ntfy: () => Promise.reject(new Error("unused")),
      command: () => Promise.reject(new Error("unused")),
    });
    expect(() => svc.notify("error", "t", "b")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

function recordingSink(sent: string[]): NotificationSink {
  return {
    notifySend: (title, body) => {
      sent.push(`notify_send:${title}:${body}`);
      return Promise.resolve();
    },
    ntfy: (_config, title, body) => {
      sent.push(`ntfy:${title}:${body}`);
      return Promise.resolve();
    },
    command: (template, title, body) => {
      sent.push(`command:${title}:${body}:${template}`);
      return Promise.resolve();
    },
  };
}

describe("generation threshold", () => {
  for (const group of f["generation_threshold"] as Row[]) {
    const thresholdMs = BigInt(group["threshold_ms"] as string | number);
    const svc = new NotificationService(
      configWith({
        enabled: true,
        generation_threshold: ConfigDuration.fromMillis(thresholdMs),
        events: { ...defaultNotificationsConfig().events, message_complete: true },
      }),
    );
    for (const c of group["cases"] as Row[]) {
      test(`${group["name"] as string} @ ${c["total_ms"] as number}ms`, () => {
        expect(svc.meetsGenerationThreshold(c["total_ms"] as number)).toBe(
          c["meets_threshold"] as boolean,
        );
      });
    }
  }

  test("notify_message_complete honours both the threshold and the toggle", async () => {
    const sent: string[] = [];
    const svc = new NotificationService(
      configWith({
        enabled: true,
        generation_threshold: ConfigDuration.fromMillis(1000n),
        events: { ...defaultNotificationsConfig().events, message_complete: true },
      }),
      recordingSink(sent),
    );
    svc.notifyMessageComplete("t", "fast", 999);
    svc.notifyMessageComplete("t", "slow", 1000);
    await Promise.resolve();
    expect(sent).toEqual(["notify_send:t:slow"]);
  });

  test("an event that is off by default stays off even with notifications enabled", async () => {
    const sent: string[] = [];
    const svc = new NotificationService(configWith({ enabled: true }), recordingSink(sent));
    expect(defaultNotificationEvents().cache_warning).toBe(false);
    svc.notify("cache_warning", "t", "b");
    await Promise.resolve();
    expect(sent).toEqual([]);
  });

  test("message_complete rides the default event set", async () => {
    const sent: string[] = [];
    const svc = new NotificationService(configWith({ enabled: true }), recordingSink(sent));
    svc.notifyMessageComplete("t", "b", 10_000);
    await Promise.resolve();
    expect(sent).toEqual(["notify_send:t:b"]);
  });
});

function configToFixtureShape(config: NotificationsConfig): Row {
  return {
    enabled: config.enabled,
    backend: config.backend,
    ntfy: { url: config.ntfy.url, topic: config.ntfy.topic, token: config.ntfy.token },
    command: { template: config.command.template },
    generation_threshold_ms: config.generation_threshold.asMillisExact().toString(),
    events: { ...config.events },
  };
}

function readNotificationsConfig(
  table: Record<string, unknown>,
): { ok: NotificationsConfig } | { err: string } {
  const parsed = parseAppConfig({ notifications: table });
  return "err" in parsed ? parsed : { ok: parsed.ok.notifications };
}

const DOCUMENT_PATH_ONLY = new Set([
  "unknown_order_desc",
  "unknown_after_known",
  "ntfy_unknown_field",
  "unknown_two_keys",
  "backend_wrong_type",
]);

const BUN_REFUSES_THE_DOCUMENT = new Set(["threshold_i64_max"]);

describe("[notifications] parsing", () => {
  const emptyCase = (f["config_parse"] as Row[]).find((c) => c["name"] === "empty")?.["ok"] as
    | Row
    | undefined;
  const recordedEventDefaults = emptyCase?.["events"];

  for (const c of f["config_parse"] as Row[]) {
    if (DOCUMENT_PATH_ONLY.has(c["name"] as string)) continue;
    if (BUN_REFUSES_THE_DOCUMENT.has(c["name"] as string)) continue;
    test(c["name"] as string, () => {
      const table = Bun.TOML.parse(c["toml"] as string) as Record<string, unknown>;
      const parsed = readNotificationsConfig(table);
      if ("err" in c) {
        expect<string>("err" in parsed ? parsed.err : `unexpectedly parsed: ${c["name"] as string}`).toBe(
          c["err"] as string,
        );
        return;
      }
      expect("err" in parsed ? parsed.err : "").toBe("");
      const expected = { ...(c["ok"] as Row) };
      expected["generation_threshold_ms"] = String(expected["generation_threshold_ms"]);
      expected["events"] = replayOntoCurrentDefaults(
        expected["events"],
        recordedEventDefaults,
        { ...defaultNotificationEvents() },
        pathsSetBy((table["events"] ?? {})),
      );
      expect(configToFixtureShape((parsed as { ok: NotificationsConfig }).ok)).toEqual(expected);
    });
  }

  test("the float literals nan/inf/-inf decode as floats", () => {
    expect(Bun.TOML.parse("a = nan")).toEqual({ a: Number.NaN });
    expect(Bun.TOML.parse("a = inf")).toEqual({ a: Infinity });
    expect((Bun.TOML.parse("a = -inf") as Row)["a"]).toBe(-Infinity);
  });

  test("the recorded i64::MAX threshold cannot be replayed — Bun refuses the document", () => {
    const c = (f["config_parse"] as Row[]).find((x) => x["name"] === "threshold_i64_max");
    if (c === undefined) throw new Error("fixture case missing");
    expect((c["ok"] as Row)["generation_threshold_ms"]).toBe("18446744073709551615");
    expect(() => Bun.TOML.parse(c["toml"] as string)).toThrow("losslessly");
  });

  test("a bare number on generation_threshold is seconds", () => {
    const parsed = readNotificationsConfig(
      Bun.TOML.parse("generation_threshold = 30\n") as Record<string, unknown>,
    );
    expect("ok" in parsed && parsed.ok.generation_threshold.asMillis()).toBe(30_000);
  });
});

describe("ntfy url", () => {
  for (const c of f["ntfy_url"] as Row[]) {
    test(`${c["url"] as string} + ${c["topic"] as string}`, () => {
      expect(ntfyUrl({ url: c["url"] as string, topic: c["topic"] as string, token: "" })).toBe(
        c["rendered"] as string,
      );
    });
  }

  test("an empty topic is refused before the URL is built", async () => {
    const svc = new NotificationService(
      configWith({
        enabled: true,
        backend: "ntfy",
        ntfy: { url: "https://ntfy.sh", topic: "", token: "" },
        events: { ...defaultNotificationEvents(), error: true },
      }),
    );
    const { realSink } = await import("../src/notifications.ts");
    expect(
      realSink.ntfy({ url: "https://ntfy.sh", topic: "", token: "" }, "t", "b"),
    ).rejects.toThrow("ntfy topic is not configured");
    expect(svc.shouldNotify("error")).toBe(true);
  });
});

function blockToFixtureShape(block: ContentBlock): Row {
  if (block.type === "thinking") {
    return {
      type: "thinking",
      thinking: block.thinking,
      signature: block.signature ?? null,
      reasoning_details: block.reasoning_details ?? null,
      reasoning_content: block.reasoning_content ?? null,
    };
  }
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "redacted_thinking") return { type: "redacted_thinking", data: block.data };
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? null };
  }
  if (block.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: block.content,
      is_error: block.is_error ?? false,
    };
  }
  return { type: block.type };
}

function resultToFixtureShape(r: StreamResult): Row {
  return {
    content: r.content,
    model: r.model,
    finish_reason: r.finish_reason,
    usage: {
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      cache_read_tokens: r.usage.cache_read_tokens,
      cache_creation_tokens: r.usage.cache_creation_tokens,
      total_cost_usd: r.usage.total_cost_usd ?? null,
    },
    timing: { total_ms: r.timing.total_ms, time_to_first_token_ms: r.timing.time_to_first_token_ms },
    tool_uses: r.tool_uses.map((t) => ({ id: t.id, name: t.name, input: t.input ?? null })),
    content_blocks: r.content_blocks.map(blockToFixtureShape),
  };
}

function frameToFixtureShape(m: ServerMessage): Row {
  const any = m as unknown as Row;
  if (m.type === "stream_start") {
    return { type: "stream_start", rid: any["rid"] ?? null, regen: any["regen"], subagent: null };
  }
  if (m.type === "stream_chunk") {
    return {
      type: "stream_chunk",
      rid: any["rid"] ?? null,
      text: any["text"],
      content_type: any["content_type"],
      subagent: null,
    };
  }
  return { type: m.type };
}

async function* decodeLines(lines: string[]): AsyncIterable<StreamEvent> {
  const KNOWN = new Set([
    "start",
    "text",
    "thinking",
    "thinking_signature",
    "reasoning_details",
    "reasoning_content",
    "redacted_thinking",
    "tool_use",
    "done",
    "call_complete",
    "ping",
    "error",
  ]);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("deserialize");
    }
    const type = (parsed as Row)["type"];
    if (typeof type !== "string" || !KNOWN.has(type)) throw new Error("deserialize");
    yield fillEventDefaults(parsed as Row) as StreamEvent;
  }
}

function fillEventDefaults(event: Row): Row {
  if (event["type"] !== "error") return event;
  return {
    type: "error",
    message: event["message"] ?? "",
    usage: event["usage"] ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    timing: event["timing"] ?? { total_ms: 0, time_to_first_token_ms: 0 },
  };
}

describe("stream accumulation", () => {
  for (const c of f["streams"] as Row[]) {
    test(c["name"] as string, async () => {
      const frames: ServerMessage[] = [];
      const sink: FrameSink = (m) => frames.push(m);
      const rid = c["rid"] as string | null;

      let outcome: Row;
      try {
        const res = await consumeStream(decodeLines(c["lines"] as string[]), {
          regen: c["regen"] as boolean,
          sink,
          ...(rid === null ? {} : { rid }),
        });
        outcome =
          "ok" in res
            ? { ok: resultToFixtureShape(res.ok) }
            : {
                err:
                  res.err.kind === "stream_errored"
                    ? {
                        kind: "stream_errored",
                        message: res.err.message,
                        usage: {
                          input_tokens: res.err.usage.input_tokens,
                          output_tokens: res.err.usage.output_tokens,
                          cache_read_tokens: res.err.usage.cache_read_tokens,
                          cache_creation_tokens: res.err.usage.cache_creation_tokens,
                        },
                        timing: {
                          total_ms: res.err.timing.total_ms,
                          time_to_first_token_ms: res.err.timing.time_to_first_token_ms,
                        },
                      }
                    : { kind: res.err.kind },
              };
      } catch {
        outcome = { err: { kind: "deserialize" } };
      }

      const expected = structuredClone(c["outcome"]) as Row;
      stripStoredSignature(expected);
      if (
        typeof expected["err"] === "object" &&
        expected["err"] !== null &&
        (expected["err"] as Row)["kind"] === "deserialize"
      ) {
        expected["err"] = { kind: "deserialize" };
      }

      expect(outcome).toEqual(expected);
      expect(frames.map(frameToFixtureShape)).toEqual(c["frames"] as Row[]);
    });
  }

  test("the carrier lands in its own field, never behind a prefix", () => {
    for (const c of f["streams"] as Row[]) {
      const blocks = ((c["outcome"] as Row)["ok"] as Row | undefined)?.["content_blocks"] as
        | Row[]
        | undefined;
      for (const block of blocks ?? []) {
        if (block["type"] !== "thinking") continue;
        const stored = block["stored_signature"] as string | null;
        if (stored === null) continue;
        if (stored.startsWith("orrd:")) {
          expect(block["reasoning_details"]).toEqual(JSON.parse(stored.slice(5)));
          expect(block["signature"]).toBeNull();
        } else if (stored.startsWith("zair:")) {
          expect(block["reasoning_content"]).toBe(stored.slice(5));
          expect(block["signature"]).toBeNull();
        } else {
          expect(block["signature"]).toBe(stored);
        }
      }
    }
  });

  test("finish hands over its arrays rather than aliasing them", () => {
    const acc = new StreamAccumulator();
    const sink: FrameSink = () => {};
    acc.handle({ type: "text", text: "a" }, false, sink);
    const first = acc.finish("a", "end_turn", zeroUsage(), {
      total_ms: 0,
      time_to_first_token_ms: 0,
    });
    acc.handle({ type: "text", text: "b" }, false, sink);
    const second = acc.finish("b", "end_turn", zeroUsage(), {
      total_ms: 0,
      time_to_first_token_ms: 0,
    });
    expect(first.content_blocks).toEqual([{ type: "text", text: "a" }]);
    expect(second.content_blocks).toEqual([{ type: "text", text: "b" }]);
  });
});

function stripStoredSignature(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripStoredSignature(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const row = node as Row;
  delete row["stored_signature"];
  for (const value of Object.values(row)) stripStoredSignature(value);
}

function zeroUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

describe("emit_stream_end", () => {
  for (const c of f["stream_end"] as Row[]) {
    test(c["name"] as string, () => {
      const expectedFrame = c["frame"] as Row;
      const result = fixtureResult(c["result"] as Row);
      const frames: ServerMessage[] = [];
      const rid = c["rid"] as string | null;
      const msgId = c["msg_id"] as string | null;
      const revision = c["revision"] as number | null;

      emitStreamEnd((m) => frames.push(m), result, {
        isFinal: c["is_final"] as boolean,
        ...(rid === null ? {} : { rid }),
        ...(msgId === null ? {} : { msgId }),
        ...(revision === null ? {} : { revision }),
      });

      expect(frames).toHaveLength(1);
      const frame = frames[0] as unknown as Row;
      expect(frame["type"]).toBe("stream_end");
      expect(frame["rid"] ?? null).toEqual(expectedFrame["rid"] ?? null);
      expect(frame["msg_id"] ?? null).toEqual(expectedFrame["msg_id"] ?? null);
      expect(frame["revision"] ?? null).toEqual(expectedFrame["revision"] ?? null);
      expect(frame["content"]).toEqual(expectedFrame["content"]);
      expect(frame["finish_reason"]).toEqual(expectedFrame["finish_reason"]);
      expect(frame["is_final"]).toEqual(expectedFrame["is_final"]);
      expect(frame["metadata"]).toEqual(expectedFrame["metadata"]);
    });
  }

  test("an absent revision is an absent key, not zero", () => {
    const frames: ServerMessage[] = [];
    emitStreamEnd((m) => frames.push(m), fixtureResult(required((f["stream_end"] as Row[])[0])["result"] as Row), {
      isFinal: true,
    });
    expect(Object.hasOwn(frames[0] as object, "revision")).toBe(false);
  });
});

function fixtureResult(row: Row): StreamResult {
  const usage = row["usage"] as Row;
  const timing = row["timing"] as Row;
  const cost = usage["total_cost_usd"];
  return {
    content: row["content"] as string,
    model: row["model"] as string,
    finish_reason: row["finish_reason"] as string,
    usage: {
      input_tokens: usage["input_tokens"] as number,
      output_tokens: usage["output_tokens"] as number,
      cache_read_tokens: usage["cache_read_tokens"] as number,
      cache_creation_tokens: usage["cache_creation_tokens"] as number,
      ...(cost === null || cost === undefined ? {} : { total_cost_usd: cost as number }),
    },
    timing: {
      total_ms: timing["total_ms"] as number,
      time_to_first_token_ms: timing["time_to_first_token_ms"] as number,
    },
    tool_uses: [],
    content_blocks: [],
  };
}

function fixtureBlock(row: Row): ContentBlock {
  switch (row["type"]) {
    case "text":
      return { type: "text", text: row["text"] as string };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: row["data"] as string };
    case "tool_use":
      return {
        type: "tool_use",
        id: row["id"] as string,
        name: row["name"] as string,
        input: row["input"],
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: row["tool_use_id"] as string,
        content: row["content"] as string,
        is_error: row["is_error"] as boolean,
      };
    default: {
      const block: ContentBlock = { type: "thinking", thinking: row["thinking"] as string };
      if (row["signature"] !== null && row["signature"] !== undefined) {
        block.signature = row["signature"] as string;
      }
      if (row["reasoning_details"] !== null && row["reasoning_details"] !== undefined) {
        block.reasoning_details = row["reasoning_details"] as unknown[];
      }
      if (row["reasoning_content"] !== null && row["reasoning_content"] !== undefined) {
        block.reasoning_content = row["reasoning_content"] as string;
      }
      return block;
    }
  }
}

function fixtureCompleted(row: Row): CompletedResponseMessage {
  return {
    role: row["role"] as CompletedResponseMessage["role"],
    content_blocks: (row["content_blocks"] as Row[]).map(fixtureBlock),
  };
}

function fixtureResultWithBlocks(row: Row): StreamResult {
  return {
    ...fixtureResult(row),
    content_blocks: (row["content_blocks"] as Row[]).map(fixtureBlock),
  };
}

describe("completed_response_messages", () => {
  for (const c of f["completed_messages"] as Row[]) {
    test(c["name"] as string, () => {
      const result = fixtureResultWithBlocks(c["result"] as Row);
      expect(contentBlocksForResult(result).map(blockToFixtureShape)).toEqual(
        (c["content_blocks_for_result"] as Row[]).map((r) => blockToFixtureShape(fixtureBlock(r))),
      );
      const completed = completedResponseMessages(result);
      expect(
        completed.map((m) => ({
          role: m.role,
          content_blocks: m.content_blocks.map(blockToFixtureShape),
        })),
      ).toEqual(
        (c["completed"] as Row[]).map((r) => ({
          role: r["role"] as CompletedResponseMessage["role"],
          content_blocks: (r["content_blocks"] as Row[]).map((b) => blockToFixtureShape(fixtureBlock(b))),
        })),
      );
      expect(notifyContentFromResponseMessages(completed)).toBe(c["notify_content"] as string);
    });
  }
});

describe("notify_content", () => {
  for (const c of f["notify_content"] as Row[]) {
    test(c["name"] as string, () => {
      const messages = (c["messages"] as Row[]).map(fixtureCompleted);
      expect(notifyContentFromResponseMessages(messages)).toBe(c["notify_content"] as string);
    });
  }
});

describe("message_from_response", () => {
  const ctx = {
    now: () => "2026-08-03T00:00:00+00:00",
    newMessageId: () => "m_00000000-0000-0000-0000-000000000000",
  };

  for (const c of f["message_from_response"] as Row[]) {
    test(c["name"] as string, () => {
      const built = messageFromResponse(
        ctx,
        fixtureCompleted(c["input"] as Row),
        c["provider_key"] as string,
        c["model"] as string,
      );
      const expected = c["message"] as Row;
      expect(built.role).toBe(expected["role"] as CompletedResponseMessage["role"]);
      expect(built.content).toBe(expected["content"] as string);
      expect(built.provider_key ?? null).toBe((expected["provider_key"] ?? null) as string | null);
      expect(built.model ?? null).toBe((expected["model"] ?? null) as string | null);
      expect(built.images).toEqual([]);
      expect(built.alternatives).toEqual([]);
      expect(Object.hasOwn(built, "origin")).toBe(false);
      expect(Object.hasOwn(built, "alt_index")).toBe(false);
      expect(Object.hasOwn(built, "alt_count")).toBe(false);
      expect(built.msg_id.slice(0, 2)).toBe(expected["msg_id_prefix"] as string);
      expect(built.msg_id.length).toBe(expected["msg_id_len"] as number);
    });
  }
});

function wireTurnToFixtureShape(turn: {
  role: string;
  content: ContentBlock[];
  provider_key?: string;
  model?: string;
}): Row {
  const out: Row = {
    role: turn.role,
    content: turn.content.map((b) => {
      if (b.type !== "thinking") return blockToFixtureShapeWire(b);
      const block: Row = { type: "thinking", thinking: b.thinking };
      if (b.signature !== undefined) block["signature"] = b.signature;
      if (b.reasoning_details !== undefined) block["reasoning_details"] = b.reasoning_details;
      if (b.reasoning_content !== undefined) block["reasoning_content"] = b.reasoning_content;
      return block;
    }),
  };
  if (turn.provider_key !== undefined) out["provider_key"] = turn.provider_key;
  if (turn.model !== undefined) out["model"] = turn.model;
  return out;
}

function blockToFixtureShapeWire(b: ContentBlock): Row {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "redacted_thinking") return { type: "redacted_thinking", data: b.data };
  if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
  if (b.type === "tool_result") {
    const out: Row = { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content };
    if (b.is_error !== undefined) out["is_error"] = b.is_error;
    return out;
  }
  return { type: b.type };
}

describe("last_request_with_response", () => {
  for (const c of f["last_request"] as Row[]) {
    test(c["name"] as string, () => {
      const providerKey = c["provider_key"] as string | null;
      const sent = (c["sent"] as Row[]).map(fixtureWireTurn);
      const request: WireRequest = {
        model: "claude-opus-5",
        messages: sent,
        ...(providerKey === null ? {} : { provider_key: providerKey }),
      };
      const before = structuredClone(sent);
      const full = lastRequestWithResponse(
        request,
        (c["response"] as Row[]).map(fixtureCompleted),
      );

      expect(full.messages.map(wireTurnToFixtureShape)).toEqual(
        (c["messages_after"] as Row[]).map(normalizeWireRow),
      );
      expect(request.messages).toHaveLength(before.length);
      expect(structuredClone(request.messages)).toEqual(before);
      expect(c["prefix_unchanged"]).toBe(true);
    });
  }

  test("append_response_messages_to_request appends in place", () => {
    const row = f["append_in_place"];
    const request: WireRequest = {
      model: "claude-opus-5",
      provider_key: "p",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    };
    const response: CompletedResponseMessage[] = [
      { role: "assistant", content_blocks: [{ type: "text", text: "a" }] },
    ];
    appendResponseMessagesToRequest(request, response);
    appendResponseMessagesToRequest(request, response);
    expect(request.messages).toHaveLength(row["count"] as number);
    expect(request.messages.map(wireTurnToFixtureShape)).toEqual(
      (row["messages"] as Row[]).map(normalizeWireRow),
    );
  });
});

function fixtureWireTurn(row: Row): WireRequest["messages"][number] {
  const out: WireRequest["messages"][number] = {
    role: row["role"] as "user" | "assistant" | "system",
    content: (row["content"] as Row[]).map(fixtureWireBlock),
  };
  if (row["provider_key"] !== undefined && row["provider_key"] !== null) {
    out.provider_key = row["provider_key"] as string;
  }
  if (row["model"] !== undefined && row["model"] !== null) out.model = row["model"] as string;
  return out;
}

function fixtureWireBlock(row: Row): ContentBlock {
  if (row["type"] !== "thinking") return fixtureBlock(row);
  const block: ContentBlock = { type: "thinking", thinking: row["thinking"] as string };
  const carrier = (row["carrier"] ?? row) as Row;
  if (carrier["signature"] !== undefined && carrier["signature"] !== null) {
    block.signature = carrier["signature"] as string;
  }
  if (carrier["reasoning_details"] !== undefined && carrier["reasoning_details"] !== null) {
    block.reasoning_details = carrier["reasoning_details"] as unknown[];
  }
  if (carrier["reasoning_content"] !== undefined && carrier["reasoning_content"] !== null) {
    block.reasoning_content = carrier["reasoning_content"] as string;
  }
  return block;
}

function normalizeWireRow(row: Row): Row {
  return wireTurnToFixtureShape(fixtureWireTurn(row));
}

class FakeEngine implements PersistEngine {
  messages: Message[] = [];
  #revision = 0;
  replaced: Message[] | undefined = undefined;

  appendMessage(msg: Message): Promise<void> {
    this.messages.push(msg);
    this.#revision += 1;
    return Promise.resolve();
  }

  replaceAfterLastUserTurn(newMessages: Message[]): Promise<number> {
    this.replaced = newMessages;
    this.messages = newMessages;
    this.#revision += 1;
    return Promise.resolve(0);
  }

  currentRevision(): number {
    return this.#revision;
  }

  turnCount(): number {
    return this.messages.length;
  }
}

function makeContext(): {
  ctx: PersistContext;
  events: ServerMessage[];
  direct: ServerMessage[];
  notified: string[];
  lastRequests: WireRequest[];
} {
  const events: ServerMessage[] = [];
  const direct: ServerMessage[] = [];
  const notified: string[] = [];
  const lastRequests: WireRequest[] = [];
  let n = 0;

  const ctx: PersistContext = {
    emitEvent: (m) => events.push(m),
    sendDirect: (m) => direct.push(m),
    autonomy: {
      notifyLastRequest: (_c, r) => lastRequests.push(r),
      notifyAssistantMessage: () => {},
    },
    notifier: new NotificationService(
      configWith({
        enabled: true,
        events: {
          ...defaultNotificationEvents(),
          message_complete: true,
          usage_warning: true,
          error: true,
        },
      }),
      recordingSink(notified),
    ),
    newlyCrossedUsageBudgetWarnings: () => Promise.resolve([]),
    now: () => "2026-08-03T00:00:00+00:00",
    newMessageId: () => `m_${(n += 1)}`,
  };
  return { ctx, events, direct, notified, lastRequests };
}

function resultWith(content: string, blocks: ContentBlock[]): StreamResult {
  return {
    content,
    model: "claude-test",
    finish_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 3,
      cache_creation_tokens: 1,
    },
    timing: { total_ms: 100, time_to_first_token_ms: 20 },
    tool_uses: [],
    content_blocks: blocks,
  };
}

describe("persist_and_notify", () => {
  test("appends the response, emits one new_message, and notifies", async () => {
    const { ctx, events, notified, lastRequests } = makeContext();
    const engine = new FakeEngine();
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "anthropic",
      result: resultWith("hi", [{ type: "text", text: "hi" }]),
      request: { model: "claude-opus-5", provider_key: "anthropic", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [],
      wallClockMs: 500,
    });

    expect(engine.messages).toHaveLength(1);
    expect(engine.messages[0]?.provider_key).toBe("anthropic");
    expect(engine.messages[0]?.model).toBe("claude-test");
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as Row)["origin"]).toBe("assistant_reply");
    expect(notified).toEqual(["notify_send:Shore — Alice:hi"]);
    expect(lastRequests[0]?.messages).toHaveLength(1);
  });

  test("a result with nothing in it persists nothing and emits nothing", async () => {
    const { ctx, events, notified } = makeContext();
    const engine = new FakeEngine();
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "anthropic",
      result: resultWith("", []),
      request: { model: "claude-opus-5", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [],
      wallClockMs: 500,
    });
    expect(engine.messages).toEqual([]);
    expect(events).toEqual([]);
    expect(notified).toEqual(["notify_send:Shore — Alice:"]);
  });

  test("tool-loop turns are appended before the response and raise no events", async () => {
    const { ctx, events } = makeContext();
    const engine = new FakeEngine();
    const intermediate: Message = {
      msg_id: "m_tool",
      role: "assistant",
      content: "",
      images: [],
      content_blocks: [{ type: "tool_use", id: "t", name: "n", input: {} }],
      timestamp: "t",
    };
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "anthropic",
      result: resultWith("done", [{ type: "text", text: "done" }]),
      request: { model: "m", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [intermediate],
      wallClockMs: 1,
    });
    expect(engine.messages.map((m) => m.msg_id)).toEqual(["m_tool", "m_1"]);
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as Row)["msg_id"]).toBe("m_1");
  });

  test("a tool-loop turn is stored with the provenance of the model that minted it", async () => {
    const { ctx } = makeContext();
    const engine = new FakeEngine();
    const assistantTurn: Message = {
      msg_id: "m_tool",
      role: "assistant",
      content: "",
      images: [],
      content_blocks: [
        { type: "thinking", thinking: "why not", reasoning_content: "why not" },
        { type: "tool_use", id: "t", name: "n", input: {} },
      ],
      timestamp: "t",
    };
    const toolResult: Message = {
      msg_id: "m_result",
      role: "user",
      content: "",
      images: [],
      content_blocks: [{ type: "tool_result", tool_use_id: "t", content: "ok", is_error: false }],
      timestamp: "t",
    };
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "zai",
      result: { ...resultWith("done", [{ type: "text", text: "done" }]), model: "glm-5.3" },
      request: { model: "glm-5.3", provider_key: "zai", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [assistantTurn, toolResult],
      wallClockMs: 1,
    });

    const stored = engine.messages.find((m) => m.msg_id === "m_tool");
    expect(stored?.provider_key).toBe("zai");
    expect(stored?.model).toBe("glm-5.3");
    const result = engine.messages.find((m) => m.msg_id === "m_result");
    expect(result?.provider_key).toBeUndefined();
    expect(result?.model).toBeUndefined();
  });

  test("a regeneration replaces the tail, stamps alternatives, and reports one revision", async () => {
    const { ctx, events } = makeContext();
    const engine = new FakeEngine();
    const prior: PendingAlt = {
      alternatives: [
        {
          content: "first try",
          images: [],
          content_blocks: [{ type: "text", text: "first try" }],
          timestamp: "t0",
        },
      ],
    };
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "anthropic",
      result: resultWith("again", [{ type: "text", text: "again" }]),
      request: { model: "m", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [],
      wallClockMs: 1,
      regenAlt: prior,
    });
    expect(engine.replaced).toBeDefined();
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as Row)["revision"]).toBe(engine.currentRevision());
    const stored = engine.messages[0] as Message;
    expect(stored.alt_count).toBe(2);
    expect(stored.alt_index).toBe(1);
    expect(stored.alternatives?.map((a) => a.content)).toEqual(["first try", "again"]);
  });

  test("a regeneration's event is a deep copy too", async () => {
    const { ctx, events } = makeContext();
    const engine = new FakeEngine();
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "anthropic",
      result: resultWith("again", [{ type: "text", text: "again" }]),
      request: { model: "m", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [],
      wallClockMs: 1,
      regenAlt: { alternatives: [] },
    });
    const stored = engine.messages[0] as Message;
    const emitted = events[0] as unknown as Row;
    expect(emitted["content_blocks"]).not.toBe(stored.content_blocks);
    expect(emitted["alt_count"]).toBe(stored.alt_count);
  });

  test("a regeneration's tool-loop turns are replaced but raise no events", async () => {
    const { ctx, events } = makeContext();
    const engine = new FakeEngine();
    const intermediate: Message = {
      msg_id: "m_tool",
      role: "assistant",
      content: "",
      images: [],
      content_blocks: [{ type: "tool_use", id: "t", name: "n", input: {} }],
      timestamp: "t",
    };
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "anthropic",
      result: resultWith("again", [{ type: "text", text: "again" }]),
      request: { model: "m", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [intermediate],
      wallClockMs: 1,
      regenAlt: { alternatives: [] },
    });
    expect(engine.replaced?.map((m) => m.msg_id)).toEqual(["m_tool", "m_1"]);
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as Row)["msg_id"]).toBe("m_1");
  });

  test("the request's provider key wins over the resolved model's", async () => {
    const { ctx } = makeContext();
    const engine = new FakeEngine();
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "fallback",
      result: resultWith("hi", [{ type: "text", text: "hi" }]),
      request: { model: "m", provider_key: "from-request", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [],
      wallClockMs: 1,
    });
    expect(engine.messages[0]?.provider_key).toBe("from-request");
  });

  test("an empty reported model falls back to the requested one", async () => {
    const { ctx } = makeContext();
    const engine = new FakeEngine();
    const result = resultWith("hi", [{ type: "text", text: "hi" }]);
    result.model = "";
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "p",
      result,
      request: { model: "requested-model", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [],
      wallClockMs: 1,
    });
    expect(engine.messages[0]?.model).toBe("requested-model");
  });

  test("budget warnings go to the session and to the notifier", async () => {
    const { ctx, direct, notified } = makeContext();
    ctx.newlyCrossedUsageBudgetWarnings = () =>
      Promise.resolve([
        {
          budget: "daily",
          message: "over budget",
          current_cost: 12,
          cost_limit: 10,
          percent_used: 1.2,
          crossed_warn_at: [1],
          period: "day",
          period_start: "s",
          reset_at: "r",
          reset_at_display: "d",
          scope: "budget",
        },
        {
          budget: "daily",
          message: "ahead of pace",
          current_cost: 6,
          cost_limit: 10,
          percent_used: 0.6,
          crossed_warn_at: [0.8],
          period: "day",
          period_start: "s",
          reset_at: "r",
          reset_at_display: "d",
          scope: "pace",
        },
      ]);
    await persistAndNotify(ctx, new FakeEngine(), {
      charName: "Alice",
      resolvedProviderKey: "p",
      result: resultWith("hi", [{ type: "text", text: "hi" }]),
      request: { model: "m", messages: [], rid: "req-1" },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [],
      wallClockMs: 1,
    });
    expect(direct).toHaveLength(2);
    expect((direct[0] as unknown as Row)["scope"]).toBeNull();
    expect((direct[1] as unknown as Row)["scope"]).toBe("pace");
    expect((direct[0] as unknown as Row)["rid"]).toBe("req-1");
    expect(notified).toContain("notify_send:Shore usage warning:over budget");
  });

  test("a failing budget check does not fail the persistence", async () => {
    const { ctx, direct } = makeContext();
    ctx.newlyCrossedUsageBudgetWarnings = () => Promise.reject(new Error("ledger down"));
    const engine = new FakeEngine();
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "p",
      result: resultWith("hi", [{ type: "text", text: "hi" }]),
      request: { model: "m", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [],
      wallClockMs: 1,
    });
    expect(engine.messages).toHaveLength(1);
    expect(direct).toEqual([]);
  });

  test("the emitted event is a deep copy — inlining images cannot reach the store", async () => {
    const { ctx, events } = makeContext();
    const engine = new FakeEngine();
    await persistAndNotify(ctx, engine, {
      charName: "Alice",
      resolvedProviderKey: "p",
      result: resultWith("hi", [{ type: "text", text: "hi" }]),
      request: { model: "m", messages: [] },
      keepaliveIntervalMs: undefined,
      toolIntermediateMessages: [],
      wallClockMs: 1,
    });
    const stored = engine.messages[0] as Message;
    const emitted = events[0] as unknown as Row;
    expect(emitted["content_blocks"]).not.toBe(stored.content_blocks);
    expect(Object.hasOwn(stored, "origin")).toBe(false);
  });
});

describe("applyGeneratedMessagesToEngine", () => {
  test("each appended message reports the revision it landed in", async () => {
    const engine = new FakeEngine();
    const events: ServerMessage[] = [];
    const messages: Message[] = ["a", "b"].map((id) => ({
      msg_id: id,
      role: "assistant",
      content: "",
      images: [],
      content_blocks: [],
      timestamp: "t",
    }));
    await applyGeneratedMessagesToEngine(engine, messages, {
      regenAlt: undefined,
      responseEventIds: ["a", "b"],
      emitEvent: (m) => events.push(m),
      charName: "Alice",
    });
    expect(events.map((e) => (e as unknown as Row)["revision"])).toEqual([1, 2]);
  });

  test("a regeneration reports one revision for every message", async () => {
    const engine = new FakeEngine();
    const events: ServerMessage[] = [];
    const messages: Message[] = ["a", "b"].map((id) => ({
      msg_id: id,
      role: "assistant",
      content: "",
      images: [],
      content_blocks: [],
      timestamp: "t",
    }));
    await applyGeneratedMessagesToEngine(engine, messages, {
      regenAlt: { alternatives: [] },
      responseEventIds: ["a", "b"],
      emitEvent: (m) => events.push(m),
      charName: "Alice",
    });
    expect(events.map((e) => (e as unknown as Row)["revision"])).toEqual([1, 1]);
  });

  test("messages outside responseEventIds are persisted silently", async () => {
    const engine = new FakeEngine();
    const events: ServerMessage[] = [];
    await applyGeneratedMessagesToEngine(
      engine,
      [
        {
          msg_id: "quiet",
          role: "assistant",
          content: "",
          images: [],
          content_blocks: [],
          timestamp: "t",
        },
      ],
      {
        regenAlt: undefined,
        responseEventIds: [],
        emitEvent: (m) => events.push(m),
        charName: "Alice",
      },
    );
    expect(engine.messages).toHaveLength(1);
    expect(events).toEqual([]);
  });
});
