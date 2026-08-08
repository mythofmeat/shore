/**
 * Replay of the cached last request against the frozen Rust fixture.
 *
 * `tests/autonomy_fixtures/last_request_parity.json` was generated in a worktree
 * at `9023b46d` by driving the real `heartbeat_rebuild_messages`,
 * `history_is_between_turns`, `heartbeat_idle_anchor_message`,
 * `rebuild_request_from_disk`, `reprime_decision` and the status tail of
 * `AutonomyManager::keepalive_ping_now`. Nothing regenerates it; a diff here is
 * a defect in `src/autonomy/{rebuild,last_request}.ts` or
 * `src/commands/keepalive.ts`, not a fixture to refresh.
 *
 * The `rebuild` section compares whole requests. That is the point: the body is
 * the prompt prefix the keepalive spends money keeping warm, so a field that
 * drifts is not a cosmetic diff — it is every ping from then on paying 2.0× for
 * a write instead of 0.1× for a read, silently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import fixture from "./autonomy_fixtures/last_request_parity.json" with { type: "json" };
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
} from "../src/autonomy/rebuild.ts";
import { LastRequestCache, reprimeDecision } from "../src/autonomy/last_request.ts";
import type { KeepalivePrefix, PingNowOutcome } from "../src/autonomy/keepalive.ts";
import { classify, keepalivePingNowCommand } from "../src/commands/keepalive.ts";
import { CommandError } from "../src/commands/errors.ts";

// ── harness ─────────────────────────────────────────────────────────────

/** The generator's model, as the TypeScript catalog spells it. */
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

/** A message as the fixture's `shape` recorded it, rebuilt into a real one. */
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

/**
 * The generator's world, with `messages` on disk for `ada`.
 *
 * `segments` is `[filesOnDisk, listedInTheManifest]`, and the two are separate
 * because the fixture's last rebuild case sets them apart: `SegmentReader`
 * counts the manifest and ignores the directory, so orphan files are not prior
 * context.
 */
async function world(
  messages: Message[],
  segments: [number, number] = [0, 0],
): Promise<{ config: LoadedConfig; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "shore-lastreq-"));
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
  await mkdir(charDir, { recursive: true });
  await writeFile(
    join(charDir, "active.jsonl"),
    messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length === 0 ? "" : "\n"),
  );

  const [files, listed] = segments;
  if (files > 0) {
    await mkdir(join(charDir, "segments"), { recursive: true });
    const entries = [];
    for (let n = 1; n <= files; n += 1) {
      const file = `${String(n).padStart(4, "0")}.jsonl`;
      await writeFile(join(charDir, "segments", file), "");
      if (n <= listed) {
        entries.push({ file, message_count: 4, compacted_at: "2025-12-01T09:00:00-05:00" });
      }
    }
    await writeFile(
      join(charDir, "compaction.json"),
      JSON.stringify({ segments: entries, total_compacted_messages: listed * 4 }, null, 2),
    );
  }

  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", FIXTURE_MODEL);

  return {
    dataDir: dirs.data,
    config: { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined },
  };
}

/** The generator's normalisation, applied to what this side built. */
function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) =>
        k === "api_key" ? [k, "<key>"] : [k, normalise(val)],
      ),
    );
  }
  // 38 characters is `m_` plus a v4 UUID: the anchor's id and nothing else, as
  // every other message here is seeded with a short one.
  if (typeof v === "string" && v.startsWith("m_") && v.length === 38) return "m_<uuid>";
  return v;
}

beforeEach(() => {
  process.env["SHORE_FIXTURE_API_KEY"] = "sk-fixture";
});

afterEach(() => {
  delete process.env["SHORE_FIXTURE_API_KEY"];
});

// ── 1. which messages a rebuild runs on ─────────────────────────────────

/**
 * The generator recorded `input` from the messages it constructed and
 * `selected` from the ones the store handed back, and the two differ: a
 * tool-result block's text becomes the message's `content` on load. So the
 * replay goes through the store too, rather than comparing against a
 * reconstruction that would have to reimplement that normalisation to agree.
 */
async function loadThroughStore(shapes: Parameters<typeof fromShape>[0][]): Promise<Message[]> {
  const { dataDir } = await world(shapes.map(fromShape));
  const { MessageStore } = await import("../src/engine/message_store.ts");
  const store = await MessageStore.load(join(dataDir, "ada", "active.jsonl"));
  return [...store.messages()];
}

describe("heartbeatRebuildMessages", () => {
  for (const c of fixture.selection) {
    test(c.note, async () => {
      const messages = await loadThroughStore(c.input);
      expect(historyIsBetweenTurns(messages)).toBe(c.between_turns);

      // A fixed anchor, so the selection is what is compared rather than a uuid.
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

  /**
   * The Rust returned `messages.to_vec()` — a copy — and the copy is not
   * incidental. The caller gets these from `MessageStore.messages()`, which
   * hands back its own array, so returning it by reference would let a rebuild's
   * caller mutate the store's conversation. Nothing does that today, which is
   * exactly why it is worth an assertion rather than a comment.
   */
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

// ── 2. the anchor ───────────────────────────────────────────────────────

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
    // The exported constant and the message must not drift apart.
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
    expect(id.slice(0, 2)).toBe(a.msg_id_prefix as string);
    expect(id).toHaveLength(a.msg_id_len);
  });
});

// ── 3. the rebuilt request ──────────────────────────────────────────────

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
        // The generator ran under this zone and the time markers render in it.
        // Without pinning it the segment cases pass on the generator's machine
        // and nowhere else.
        timeZone: fixture.timezone,
      });

      if (c.request === null) {
        expect(request).toBeUndefined();
        return;
      }
      expect(normalise(request?.request)).toEqual(c.request as never);
    });
  }

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

// ── 4. the reprime choice ───────────────────────────────────────────────

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
  /** A keepalive that only records what it was told. */
  function spy(): {
    armed: KeepalivePrefix[];
    disarmed: string[];
    service: { arm: (p: KeepalivePrefix) => void; disarm: (c: string) => void };
  } {
    const armed: KeepalivePrefix[] = [];
    const disarmed: string[] = [];
    return { armed, disarmed, service: { arm: (p) => armed.push(p), disarm: (c) => disarmed.push(c) } };
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
    }) as SidecarRequest;

  test("caching arms the keepalive from the body, with the cadence beside it", () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    cache.set("ada", body("claude-fixture"), 3_300_000);

    expect(cache.get("ada")).toEqual(body("claude-fixture"));
    expect(k.armed).toHaveLength(1);
    expect(k.armed[0]?.keepalive_interval_ms).toBe(3_300_000);
    expect(k.armed[0]?.context?.character).toBe("ada");
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

  /**
   * The character is what keys the schedule, so a body carrying someone else's
   * — a request cloned across characters, a context assembled before the
   * character was known — must be corrected rather than trusted. Every real
   * call already carries the right one, which is why this needs a case that
   * does not.
   */
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
    new LastRequestCache(k.service as never).set("ada", bare as SidecarRequest, undefined);
    expect(k.armed[0]?.context?.character).toBe("ada");
    expect(k.armed[0]?.context?.call_type).toBe("keepalive");
  });

  test("invalidating drops the body and touches the keepalive not at all", () => {
    const k = spy();
    const cache = new LastRequestCache(k.service as never);
    cache.set("ada", body("claude-fixture"), undefined);
    cache.invalidate("ada", "compaction");

    expect(cache.get("ada")).toBeUndefined();
    // Deciding what to do about the schedule is `reprimeFromDisk`'s, and it is
    // separate because it reads the file the invalidating write just changed.
    expect(k.disarmed).toEqual([]);
    expect(k.armed).toHaveLength(1);
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

  /**
   * #47: repriming is one of the three places a prefix is armed, and the only
   * one whose cadence comes back off disk rather than out of the turn that is
   * running. `rebuildRequestFromDisk` returns the whole `BuiltRequest` for
   * exactly this — returning `built.request` alone is what dropped it.
   */
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
    } as never);

    const decision = await cache.reprimeFromDisk("ada", dataDir, config);
    expect(decision.kind === "push" && decision.keepaliveIntervalMs).toBe(3_300_000);
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
    // The stale body is still cached: only the *schedule* stands down. The
    // Rust's `invalidate` is what drops it, and it is a separate call.
    expect(cache.get("ada")).toBeDefined();
  });

  test("two caches do not share bodies", () => {
    const a = new LastRequestCache();
    const b = new LastRequestCache();
    a.set("ada", body("claude-fixture"), undefined);
    expect(b.get("ada")).toBeUndefined();
  });
});

// ── 5. the ping's decision table ────────────────────────────────────────

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
              } as never,
            }
          : { detail: (c.outcome.detail as string | undefined) ?? "" }),
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

// ── 6. the command ──────────────────────────────────────────────────────

describe("keepalivePingNowCommand", () => {
  /** A context whose ping answers from a script, one per call. */
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
    usage: { input_tokens: 1200, output_tokens: 0, cache_read_tokens: read, cache_creation_tokens: write } as never,
  });

  for (const c of fixture.ping_command) {
    test(c.note, async () => {
      // Each recorded case is a rendering; the outcome behind it is scripted so
      // the command reaches exactly that branch.
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
        await expect(keepalivePingNowCommand("ada", world_.ctx)).rejects.toThrow(
          c.output.message as string,
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
    // The rebuild is what filled the cache; that is the arming.
    expect(world_.cache.get("ada")).toBeDefined();
  });

  test("`no_prefix` with nothing rebuildable skips rather than asking again", async () => {
    // A mid-turn conversation: nothing to rebuild.
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
