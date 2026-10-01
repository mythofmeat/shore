import { HistoryStore } from "../src/engine/history_store.ts";
import { writeDurable } from "../src/storage/files.ts";
import { expandShared } from "./support/shared_subtrees.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import rawFixture from "./autonomy_captures/last_request.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);
import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { Message } from "../src/engine/types.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import {
  IDLE_ANCHOR_TEXT,
  heartbeatRebuildMessages,
  historyIsBetweenTurns,
  idleAnchorMessage,
  rebuildRequestFromDisk,
} from "../src/cache/rebuild.ts";
import { LastRequestCache, reprimeDecision } from "../src/cache/last_request.ts";
import { createThread, setHomeThread, setThreadModel } from "../src/engine/threads.ts";
import type { KeepalivePrefix, PingNowOutcome } from "../src/cache/keepalive.ts";
import { classify, keepalivePingNowCommand } from "../src/commands/keepalive.ts";
import { CommandError } from "../src/commands/errors.ts";
import { testTmp } from "./support/tmp.ts";
import { setTestEnv, unsetTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";

const FIXTURE_MODEL = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: "SHORE_FIXTURE_API_KEY",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
  maxToolIterations: 4,
} as never;

function fromShape(s: {
  role: string;
  msg_id: string;
  content: string;
  autonomous: boolean;
  tool_result_only: boolean;
}): Message {
  const base: Message = {
    msg_id: s.msg_id,
    role: s.role as Message["role"],
    content: s.content,
    images: [],
    content_blocks: s.tool_result_only
      ? [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }]
      : [{ type: "text", text: s.content }],
    alternatives: [],
    timestamp: "2026-01-01T10:00:00-05:00",
  };
  return s.autonomous ? { ...base, origin: "autonomous" } : base;
}

async function world(
  messages: Message[],
  segments: [number, number] = [0, 0],
): Promise<{ config: LoadedConfig; dataDir: string }> {
  const root = await mkdtemp(testTmp("shore-lastreq-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const workspace = join(dirs.config, "characters", "ada", "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "# ada\n\nA fixture character.\n");
  await writeFile(join(workspace, "MEMORY.md"), "- nothing yet\n");
  const charDir = join(dirs.data, "ada");
  await mkdir(join(charDir, "threads", "main"), { recursive: true });
  writeDurable(join(charDir, "threads", "main", "active.jsonl"), messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length === 0 ? "" : "\n"));

  const [, listed] = segments;
  const history = HistoryStore.open(join(dirs.data, "shore.db"));
  try {
    for (let index = 0; index < listed; index += 1) {
      history.putSegment("ada", index, { file: "shore.db", message_count: 0, compacted_at: "2025-12-01T09:00:00-05:00" }, []);
    }
  } finally { history.close(); }

  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", FIXTURE_MODEL);

  return {
    dataDir: dirs.data,
    config: { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined },
  };
}

function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) =>
        k === "api_key" ? [k, "<key>"] : [k, normalise(val)],
      ),
    );
  }
  if (typeof v === "string" && v.startsWith("m_") && v.length === 38) return "m_<uuid>";
  return v;
}

beforeEach(() => {
  setTestEnv("SHORE_FIXTURE_API_KEY", "sk-fixture");
});

afterEach(() => {
  unsetTestEnv("SHORE_FIXTURE_API_KEY");
});

async function loadThroughStore(shapes: Parameters<typeof fromShape>[0][]): Promise<Message[]> {
  const { dataDir } = await world(shapes.map(fromShape));
  const { MessageStore } = await import("../src/engine/message_store.ts");
  const store = await MessageStore.load(join(dataDir, "ada", "threads", "main", "active.jsonl"));
  return [...store.messages()];
}

describe("heartbeatRebuildMessages", () => {
  for (const c of fixture.selection) {
    test(c.note, async () => {
      const messages = await loadThroughStore(c.input);
      expect(historyIsBetweenTurns(messages)).toBe(c.between_turns);

      const selected = heartbeatRebuildMessages("ada", messages, () =>
        idleAnchorMessage(
          () => "m_anchor",
          () => "2026-01-01T12:00:00-05:00",
        ),
      );

      if (c.selected === null) {
        expect(selected).toBeUndefined();
        return;
      }
      expect(selected).toBeDefined();
      expect(
        selected?.map((m) => ({
          role: m.role,
          content: m.content,
          autonomous: m.origin === "autonomous",
        })),
      ).toEqual(
        c.selected.map((s) => ({
          role: s.role as Message["role"],
          content: s.content,
          autonomous: s.autonomous,
        })),
      );
    });
  }

  test("the anchor path prepends to a copy, leaving the input alone", () => {
    const messages = [fromShape({
      role: "assistant",
      msg_id: "m_1",
      content: "hi",
      autonomous: true,
      tool_result_only: false,
    })];
    const selected = heartbeatRebuildMessages("ada", messages);
    expect(selected).toHaveLength(2);
    expect(messages).toHaveLength(1);
  });

  test("the has-user-turn path copies too — the store's array does not escape", () => {
    const messages = [
      fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
      fromShape({ role: "assistant", msg_id: "m_2", content: "hi", autonomous: false, tool_result_only: false }),
    ];
    const selected = heartbeatRebuildMessages("ada", messages);
    expect(selected).toEqual(messages);
    selected?.pop();
    expect(messages).toHaveLength(2);
  });
});

describe("idleAnchorMessage", () => {
  const a = fixture.anchor;

  test("the text, the role and the blocks", () => {
    const anchor = idleAnchorMessage(() => "m_1", () => "2026-01-01T12:00:00-05:00");
    expect(anchor.role).toBe(a.role as never);
    expect(anchor.content).toBe(a.content);
    expect(anchor.content_blocks).toEqual(a.content_blocks as never);
    expect(anchor.images).toEqual(a.images as never);
    expect(anchor.alternatives).toEqual(a.alternatives as never);
    expect(anchor.origin).toBeUndefined();
    expect(a.origin).toBeNull();
    expect(IDLE_ANCHOR_TEXT).toBe(a.content);
  });

  test("the block carries the same text as the content — an empty turn anchors nothing", () => {
    const anchor = idleAnchorMessage();
    expect(a.block_text_matches_content).toBe(true);
    expect(anchor.content_blocks[0]).toEqual({ type: "text", text: anchor.content });
  });

  test("a fresh id each call", () => {
    expect(a.msg_id_is_fresh_each_call).toBe(true);
    expect(idleAnchorMessage().msg_id).not.toBe(idleAnchorMessage().msg_id);
  });

  test("the id is `m_` plus a v4 uuid, which is the length the fixture recorded", () => {
    const id = idleAnchorMessage().msg_id;
    expect(id.slice(0, 2)).toBe(a.msg_id_prefix);
    expect(id).toHaveLength(a.msg_id_len);
  });
});

describe("rebuildRequestFromDisk", () => {
  for (const c of fixture.rebuild) {
    test(c.note, async () => {
      const { config, dataDir } = await world(c.input.map(fromShape), [
        c.segment_files,
        c.segments,
      ]);
      const request = await rebuildRequestFromDisk("ada", dataDir, config, {
        newId: () => "m_<uuid>",
        now: () => "2026-01-01T12:00:00-05:00",
        timeZone: fixture.timezone,
      });

      if (c.request === null) {
        expect(request).toBeUndefined();
        return;
      }
      expect(normalise(request?.request)).toEqual(c.request as never);
    });
  }

  test("the rebuild follows the home thread, so a moved home moves the keepalive", async () => {
    const turn = (role: string, msg_id: string, content: string): Message =>
      fromShape({ role, msg_id, content, autonomous: false, tool_result_only: false });
    const conversation = (id: string, text: string): Message[] => [
      turn("user", `m_${id}_u`, text),
      turn("assistant", `m_${id}_a`, "noted"),
    ];
    const { config, dataDir } = await world(conversation("home", "a turn in the home thread"));
    const now = "2026-09-03T12:00:00.000Z";
    await createThread(dataDir, "ada", "scratch", now);
    writeDurable(join(dataDir, "ada", "threads", "scratch", "active.jsonl"), `${conversation("scratch", "a turn in the side thread")
        .map((m) => JSON.stringify(m))
        .join("\n")}\n`);

    const beforeMove = await rebuildRequestFromDisk("ada", dataDir, config);
    expect(JSON.stringify(beforeMove?.request.messages)).not.toContain("side thread");

    await setHomeThread(dataDir, "ada", "scratch", now);

    const afterMove = await rebuildRequestFromDisk("ada", dataDir, config);
    expect(JSON.stringify(afterMove?.request.messages)).toContain("side thread");
  });

  test("the warm body is built on the thread's own model when one is pinned", async () => {
    const turn = (role: string, msg_id: string, content: string): Message =>
      fromShape({ role, msg_id, content, autonomous: false, tool_result_only: false });
    const { config, dataDir } = await world([
      turn("user", "m_u", "a turn at home"),
      turn("assistant", "m_a", "noted"),
    ]);
    config.models.chat.set("chat.other", {
      ...(FIXTURE_MODEL as object),
      name: "other",
      qualifiedName: "chat.other",
      modelId: "claude-other",
    } as never);
    const now = "2026-09-03T12:00:00.000Z";
    await setThreadModel(dataDir, "ada", "main", "chat.other", now);

    const rebuilt = await rebuildRequestFromDisk("ada", dataDir, config);
    expect(rebuilt?.request.model).toBe("claude-other");
  });

  test("a side thread's pin is used for that thread, not for home", async () => {
    const turn = (role: string, msg_id: string, content: string): Message =>
      fromShape({ role, msg_id, content, autonomous: false, tool_result_only: false });
    const { config, dataDir } = await world([
      turn("user", "m_u", "a turn at home"),
      turn("assistant", "m_a", "noted"),
    ]);
    config.models.chat.set("chat.other", {
      ...(FIXTURE_MODEL as object),
      name: "other",
      qualifiedName: "chat.other",
      modelId: "claude-other",
    } as never);
    const now = "2026-09-03T12:00:00.000Z";
    await createThread(dataDir, "ada", "scratch", now, { chat_model: "chat.other" });
    writeDurable(join(dataDir, "ada", "threads", "scratch", "active.jsonl"), `${JSON.stringify(turn("user", "m_su", "a turn in the side thread"))}\n` +
        `${JSON.stringify(turn("assistant", "m_sa", "noted"))}\n`);

    expect((await rebuildRequestFromDisk("ada", dataDir, config))?.request.model).toBe(
      "claude-fixture",
    );
    expect(
      (await rebuildRequestFromDisk("ada", dataDir, config, { thread: "scratch" }))?.request.model,
    ).toBe("claude-other");
  });

  test("no chat model resolves — no request, rather than one on a guessed model", async () => {
    const { config, dataDir } = await world([]);
    config.models = emptyCatalog();
    config.app.defaults.model = undefined;
    expect(await rebuildRequestFromDisk("ada", dataDir, config)).toBeUndefined();
  });

  test("the MCP surface reaches the request — the keepalive's whole reason", async () => {
    const { config, dataDir } = await world([]);
    const def = {
      name: "mcp__notes__search",
      description: "search notes",
      input_schema: { type: "object", properties: {} },
    };
    const withMcp = await rebuildRequestFromDisk("ada", dataDir, config, {
      mcpRegistry: { toolDefsFiltered: () => [def] as never },
    });
    const withoutMcp = await rebuildRequestFromDisk("ada", dataDir, config);

    expect(withMcp?.request.tools?.map((t) => t.name)).toContain("mcp__notes__search");
    expect(withoutMcp?.request.tools?.map((t) => t.name) ?? []).not.toContain("mcp__notes__search");
  });
});

describe("reprimeDecision", () => {
  for (const c of fixture.reprime) {
    test(c.note, async () => {
      if (!c.rebuilt) {
        expect(reprimeDecision(undefined).kind).toBe(c.decision as never);
        return;
      }
      const { config, dataDir } = await world([
        fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
        fromShape({ role: "assistant", msg_id: "m_2", content: "hi", autonomous: false, tool_result_only: false }),
      ]);
      const rebuilt = await rebuildRequestFromDisk("ada", dataDir, config);
      expect(rebuilt).toBeDefined();
      expect(reprimeDecision(rebuilt).kind).toBe(c.decision as never);
    });
  }
});

describe("LastRequestCache", () => {
  function spy(): {
    armed: KeepalivePrefix[];
    disarmed: string[];
    forgotten: string[];
    service: {
      arm: (p: KeepalivePrefix) => void;
      disarm: (c: string) => void;
      forgetMisses: (c: string) => void;
    };
  } {
    const armed: KeepalivePrefix[] = [];
    const disarmed: string[] = [];
    const forgotten: string[] = [];
    return {
      armed,
      disarmed,
      forgotten,
      service: {
        arm: (p) => armed.push(p),
        disarm: (c) => disarmed.push(c),
        forgetMisses: (c) => forgotten.push(c),
      },
    };
  }

  const body = (model: string): SidecarRequest =>
    ({
      sdk: "anthropic",
      model,
      api_key: "sk",
      messages: [],
      max_tokens: 10,
      replay_prior_thinking: "all",
      context: { character: "ada", call_type: "message", thinking_enabled: false },
    });

  test("caching arms the keepalive from the body, with the cadence beside it", () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    cache.set("ada", body("claude-fixture"), { intervalMs: 3_300_000, pings: undefined });

    expect(cache.get("ada")).toEqual(body("claude-fixture"));
    expect(k.armed).toHaveLength(1);
    expect(k.armed[0]?.keepalive_interval_ms).toBe(3_300_000);
    expect(k.armed[0]?.context?.character).toBe("ada");
  });

  test("the size the turn left cached is armed beside the cadence", () => {
    const k = spy();
    new LastRequestCache(k.service as never).set("ada", body("claude-fixture"), {
      intervalMs: 3_300_000, pings: undefined, cachedTokens: 4096,
    });
    expect(k.armed[0]?.keepalive_cached_tokens).toBe(4096);
  });

  test("no cadence means no interval key at all — absent is off, not zero", () => {
    const k = spy();
    new LastRequestCache(k.service as never).set("ada", body("claude-fixture"), undefined);
    expect("keepalive_interval_ms" in (k.armed[0] ?? {})).toBe(false);
  });

  test("call_type is left for the ping to stamp, so the two cannot disagree", () => {
    const k = spy();
    new LastRequestCache(k.service as never).set("ada", body("claude-fixture"), undefined);
    expect(k.armed[0]?.context?.call_type).toBe("message");
  });

  test("the character on the prefix is the one being armed, not the one on the body", () => {
    const k = spy();
    const stale = {
      ...body("claude-fixture"),
      context: { character: "bob", call_type: "message", thinking_enabled: false },
    } as SidecarRequest;
    new LastRequestCache(k.service as never).set("ada", stale, undefined);
    expect(k.armed[0]?.context?.character).toBe("ada");
  });

  test("a body with no context at all still arms under the right character", () => {
    const k = spy();
    const { context: _dropped, ...bare } = body("claude-fixture");
    new LastRequestCache(k.service as never).set("ada", bare, undefined);
    expect(k.armed[0]?.context?.character).toBe("ada");
    expect(k.armed[0]?.context?.call_type).toBe("keepalive");
  });

  test("invalidating drops the body, clears the miss count, and disarms nothing", () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    cache.set("ada", body("claude-fixture"), undefined);
    cache.invalidate("ada", "compaction");

    expect(cache.get("ada")).toBeUndefined();
    expect(k.disarmed).toEqual([]);
    expect(k.armed).toHaveLength(1);
    expect(k.forgotten).toEqual(["ada"]);
  });

  test("repriming from a conversation worth pinging arms and re-caches", async () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    const { config, dataDir } = await world([
      fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
      fromShape({ role: "assistant", msg_id: "m_2", content: "hi", autonomous: false, tool_result_only: false }),
    ]);

    const decision = await cache.reprimeFromDisk("ada", dataDir, config);
    expect(decision.kind).toBe("push");
    expect(cache.get("ada")).toBeDefined();
    expect(k.armed).toHaveLength(1);
    expect(k.disarmed).toEqual([]);
  });

  test("the cadence the rebuilt model asks for is armed with it", async () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    const { config, dataDir } = await world([
      fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
      fromShape({ role: "assistant", msg_id: "m_2", content: "hi", autonomous: false, tool_result_only: false }),
    ]);
    config.models.chat.set("chat.fixture", {
      ...(FIXTURE_MODEL as object),
      cacheKeepalive: { kind: "every", interval: ConfigDuration.fromSecs(3300) },
      cacheTtl: "1h",
    } as never);

    const decision = await cache.reprimeFromDisk("ada", dataDir, config);
    expect(decision.kind === "push" && decision.keepalive.intervalMs).toBe(3_300_000);
    expect(k.armed[0]?.keepalive_interval_ms).toBe(3_300_000);
  });

  test("a rebuilt model that asks for nothing arms with no interval key", async () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    const { config, dataDir } = await world([
      fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
      fromShape({ role: "assistant", msg_id: "m_2", content: "hi", autonomous: false, tool_result_only: false }),
    ]);

    await cache.reprimeFromDisk("ada", dataDir, config);
    expect("keepalive_interval_ms" in (k.armed[0] ?? {})).toBe(false);
  });

  test("the ping count the rebuilt model asks for is armed with it", async () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    const { config, dataDir } = await world([
      fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
      fromShape({ role: "assistant", msg_id: "m_2", content: "hi", autonomous: false, tool_result_only: false }),
    ]);
    config.models.chat.set("chat.fixture", {
      ...(FIXTURE_MODEL as object),
      cacheKeepalive: { kind: "every", interval: ConfigDuration.fromSecs(600) },
      cacheKeepalivePings: 9,
    } as never);

    const decision = await cache.reprimeFromDisk("ada", dataDir, config);
    expect(decision.kind === "push" && decision.keepalive.pings).toBe(9);
    expect(k.armed[0]?.keepalive_pings).toBe(9);
    expect(k.armed[0]?.context?.keepalive_window_secs).toBe(5400);
  });

  test("a rebuilt model with no keepalive arms with an empty window", async () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    const { config, dataDir } = await world([
      fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
      fromShape({ role: "assistant", msg_id: "m_2", content: "hi", autonomous: false, tool_result_only: false }),
    ]);

    await cache.reprimeFromDisk("ada", dataDir, config);
    expect(k.armed[0]?.context?.keepalive_window_secs).toBe(0);
    expect("keepalive_pings" in (k.armed[0] ?? {})).toBe(false);
  });

  test("the armed prefix names the home thread, so the warm session is the live one", async () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    const pair = (id: string) => [
      fromShape({ role: "user", msg_id: `m_${id}_u`, content: "hello", autonomous: false, tool_result_only: false }),
      fromShape({ role: "assistant", msg_id: `m_${id}_a`, content: "hi", autonomous: false, tool_result_only: false }),
    ];
    const { config, dataDir } = await world(pair("home"));
    const now = "2026-09-03T12:00:00.000Z";
    await createThread(dataDir, "ada", "scratch", now);
    writeDurable(join(dataDir, "ada", "threads", "scratch", "active.jsonl"), `${pair("scratch").map((m) => JSON.stringify(m)).join("\n")}\n`);

    await cache.reprimeFromDisk("ada", dataDir, config);
    expect(k.armed[0]?.context?.thread).toBe("main");

    await setHomeThread(dataDir, "ada", "scratch", now);
    await cache.reprimeFromDisk("ada", dataDir, config);
    expect(k.armed[1]?.context?.thread).toBe("scratch");
  });

  test("a caller that names a thread gets that one, not home", async () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    const pair = (id: string, text: string) => [
      fromShape({ role: "user", msg_id: `m_${id}_u`, content: text, autonomous: false, tool_result_only: false }),
      fromShape({ role: "assistant", msg_id: `m_${id}_a`, content: "hi", autonomous: false, tool_result_only: false }),
    ];
    const { config, dataDir } = await world(pair("home", "a turn in the home thread"));
    await createThread(dataDir, "ada", "scratch", "2026-09-03T12:00:00.000Z");
    writeDurable(join(dataDir, "ada", "threads", "scratch", "active.jsonl"), `${pair("scratch", "a turn in the side thread").map((m) => JSON.stringify(m)).join("\n")}\n`);

    const decision = await cache.reprimeFromDisk("ada", dataDir, config, { thread: "scratch" });

    expect(k.armed[0]?.context?.thread).toBe("scratch");
    expect(JSON.stringify(decision.kind === "push" && decision.request.messages)).toContain(
      "side thread",
    );
  });

  test("repriming a mid-turn conversation disarms rather than leaving the old body armed", async () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    cache.set("ada", body("claude-fixture"), undefined);
    const { config, dataDir } = await world([
      fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
    ]);

    const decision = await cache.reprimeFromDisk("ada", dataDir, config);
    expect(decision.kind).toBe("disarm");
    expect(k.disarmed).toEqual(["ada"]);
    expect(cache.get("ada")).toBeDefined();
  });

  test("two caches do not share bodies", () => {
    const a = new LastRequestCache();
    const b = new LastRequestCache();
    a.set("ada", body("claude-fixture"), undefined);
    expect(b.get("ada")).toBeUndefined();
  });
});

describe("classify", () => {
  for (const c of fixture.ping_outcome) {
    test(c.note, () => {
      const outcome: PingNowOutcome = {
        status: c.input.status as PingNowOutcome["status"],
        cold: c.input.cold,
        ...(c.input.reason === null ? {} : { reason: c.input.reason as never }),
        ...(c.outcome.kind === "sent"
          ? {
              usage: {
                input_tokens: c.outcome.input_tokens as number,
                output_tokens: 0,
                cache_read_tokens: c.outcome.cache_read_tokens as number,
                cache_creation_tokens: c.outcome.cache_creation_tokens as number,
              },
            }
          : { detail: (c.outcome.detail) ?? "" }),
      };

      const got = classify(c.from_cached_request, outcome);
      if (c.outcome.kind === "sent") {
        expect(got).toEqual({
          kind: "sent",
          fromCachedRequest: c.outcome.from_cached_request as boolean,
          cold: c.outcome.cold as boolean,
          usage: {
            inputTokens: c.outcome.input_tokens as number,
            cacheReadTokens: c.outcome.cache_read_tokens as number,
            cacheCreationTokens: c.outcome.cache_creation_tokens as number,
          },
        });
      } else {
        expect(got).toEqual({ kind: c.outcome.kind as never, detail: c.outcome.detail as string });
      }
    });
  }

  test("sent with no usage at all reports zeros, not undefined", () => {
    const got = classify(true, { status: "sent", cold: false });
    expect(got).toEqual({
      kind: "sent",
      fromCachedRequest: true,
      cold: false,
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
  });
});

describe("keepalivePingNowCommand", () => {
  async function ctx(outcomes: PingNowOutcome[], messages: Message[] = []) {
    const { config, dataDir } = await world(messages);
    const calls: string[] = [];
    const cache = new LastRequestCache();
    return {
      calls,
      cache,
      ctx: {
        config,
        dataDir,
        lastRequest: cache,
        keepalive: {
          pingNow: (character: string) => {
            calls.push(character);
            return Promise.resolve(outcomes.shift() ?? { status: "failed", cold: false, detail: "ran out" });
          },
        } as never,
      },
    };
  }

  const sent = (cold: boolean, read: number, write: number): PingNowOutcome => ({
    status: "sent",
    cold,
    usage: { input_tokens: 1200, output_tokens: 0, cache_read_tokens: read, cache_creation_tokens: write },
  });

  for (const c of fixture.ping_command) {
    test(c.note, async () => {
      const data = c.output.kind === "ok" ? (c.output.data as Record<string, unknown>) : undefined;
      const rebuilt = data?.["source"] === "rebuilt_from_disk";
      const outcomes: PingNowOutcome[] =
        data === undefined
          ? [{ status: "failed", cold: false, detail: "connection refused" }]
          : data["status"] === "skipped"
            ? [{ status: "skipped", cold: false, detail: data["reason"] as string }]
            : rebuilt
              ? [
                  { status: "skipped", cold: false, reason: "no_prefix", detail: "no cached request" },
                  sent(
                    data["status"] === "cold",
                    data["cache_read_tokens"] as number,
                    data["cache_creation_tokens"] as number,
                  ),
                ]
              : [
                  sent(
                    data["status"] === "cold",
                    data["cache_read_tokens"] as number,
                    data["cache_creation_tokens"] as number,
                  ),
                ];

      const world_ = await ctx(
        outcomes,
        rebuilt
          ? [
              fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
              fromShape({ role: "assistant", msg_id: "m_2", content: "hi", autonomous: false, tool_result_only: false }),
            ]
          : [],
      );

      if (c.output.kind === "err") {
        expect(await outcomeOf(keepalivePingNowCommand("ada", world_.ctx))).toThrow(
          c.output.message,
        );
        return;
      }
      expect(await keepalivePingNowCommand("ada", world_.ctx)).toEqual(c.output.data as never);
    });
  }

  test("`no_prefix` rebuilds, arms and asks again — exactly once", async () => {
    const world_ = await ctx(
      [
        { status: "skipped", cold: false, reason: "no_prefix", detail: "no cached request" },
        sent(false, 1150, 0),
      ],
      [
        fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false }),
        fromShape({ role: "assistant", msg_id: "m_2", content: "hi", autonomous: false, tool_result_only: false }),
      ],
    );

    const got = (await keepalivePingNowCommand("ada", world_.ctx)) as Record<string, unknown>;
    expect(world_.calls).toEqual(["ada", "ada"]);
    expect(got["source"]).toBe("rebuilt_from_disk");
    expect(world_.cache.get("ada")).toBeDefined();
  });

  test("`no_prefix` with nothing rebuildable skips rather than asking again", async () => {
    const world_ = await ctx(
      [{ status: "skipped", cold: false, reason: "no_prefix", detail: "no cached request" }],
      [fromShape({ role: "user", msg_id: "m_1", content: "hello", autonomous: false, tool_result_only: false })],
    );

    expect(await keepalivePingNowCommand("ada", world_.ctx)).toEqual({
      status: "skipped",
      character: "ada",
      reason: "no cached or rebuildable request",
    });
    expect(world_.calls).toEqual(["ada"]);
  });

  test("`budget` is not `no_prefix` — a budget skip is reported, not retried", async () => {
    const world_ = await ctx([
      { status: "skipped", cold: false, reason: "budget", detail: 'usage budget "daily"' },
    ]);
    expect(await keepalivePingNowCommand("ada", world_.ctx)).toEqual({
      status: "skipped",
      character: "ada",
      reason: 'usage budget "daily"',
    });
    expect(world_.calls).toEqual(["ada"]);
  });

  test("a failed ping is an internal error carrying the detail", async () => {
    const world_ = await ctx([{ status: "failed", cold: false, detail: "connection refused" }]);
    try {
      await keepalivePingNowCommand("ada", world_.ctx);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(CommandError);
      expect((e as CommandError).code).toBe("internal_error");
      expect((e as CommandError).message).toBe("keepalive ping failed: connection refused");
    }
  });
});
