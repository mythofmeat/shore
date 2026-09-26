import type { Message } from "../src/engine/types.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { writeDurable } from "../src/storage/files.ts";
import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import fixture from "./handler_captures/turn.json" with { type: "json" };
import { ConversationEngine } from "../src/engine/conversation.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { StreamResult } from "../src/llm/stream.ts";
import type { Usage } from "../src/llm/types.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import {
  appendUserTurn,
  contextTokensFor,
  emitPostPersistStreamEnd,
  ensureAndBackfillAutonomy,
  maybeCompact,
  type TurnAutonomy,
  type TurnContext,
  type TurnEngine,
} from "../src/handler/turn.ts";

const MINTED_ID = "m_00000000-0000-4000-8000-000000000000";
const MINTED_TS = "2026-01-01T00:00:00-05:00";

function normalisePath(p: string): string {
  const i = p.indexOf("/attachments/");
  if (i === -1) return p;
  const base = p.slice(i + "/attachments/".length);
  const parts = base.split("_");
  if (parts.length >= 3 && parts[0]?.length === 8 && parts[1]?.length === 6) {
    return `<attachment>/${parts.slice(2).join("_")}`;
  }
  return `<attachment>/${base}`;
}

const MINTED_ID_RE = /^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINTED_VERSION_RE = /^mv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "msg_id" && typeof val === "string" && MINTED_ID_RE.test(val)) {
        out[k] = "<minted_id>";
      } else if (k === "timestamp" && val === MINTED_TS) {
        out[k] = "<minted_timestamp>";
      } else if (k === "version" && typeof val === "string" && MINTED_VERSION_RE.test(val)) {
        out[k] = "<minted_version>";
      } else if (k === "path" && typeof val === "string") {
        out[k] = normalisePath(val);
      } else {
        out[k] = normalise(val);
      }
    }
    return out;
  }
  return v;
}

function pruned(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pruned);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined || val === null) continue;
      if (Array.isArray(val) && val.length === 0 && k === "alternatives") continue;
      out[k] = pruned(val);
    }
    return out;
  }
  return v;
}

const shaped = (v: unknown): unknown => pruned(normalise(v));

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "shore-turn-"));
}

function stubConfig(root: string): LoadedConfig {
  return {
    dirs: {
      config: join(root, "config"),
      data: join(root, "data"),
      cache: join(root, "cache"),
      runtime: join(root, "run"),
    },
  } as unknown as LoadedConfig;
}

interface Recorder {
  ctx: TurnContext;
  events: ServerMessage[];
  direct: ServerMessage[];
  backfills: { character: string; timestamps: Date[] }[];
}

function recorder(overrides: Partial<TurnAutonomy> = {}): Recorder {
  const events: ServerMessage[] = [];
  const direct: ServerMessage[] = [];
  const backfills: { character: string; timestamps: Date[] }[] = [];

  const autonomy: TurnAutonomy = {
    ensureState: () => true,
    needsActivityBackfill: () => true,
    backfillActivity: (character, timestamps) =>
      backfills.push({ character, timestamps: [...timestamps] }),
    onUserMessage: () => {},
    shouldCompactNow: () => false,
    onCompactionComplete: () => {},
    onCompactionFailed: () => {},
    ...overrides,
  };

  return {
    ctx: {
      emitEvent: (m) => events.push(m),
      sendDirect: (m) => direct.push(m),
      autonomy,
      now: () => MINTED_TS,
      newMessageId: () => MINTED_ID,
    },
    events,
    direct,
    backfills,
  };
}

async function seedCharacter(root: string, history: unknown[]): Promise<string> {
  const dataDir = join(root, "data");
  const charDir = join(dataDir, "ada");
  await mkdir(join(charDir, "threads", "main"), { recursive: true });
  if (history.length > 0) {
    writeDurable(join(charDir, "threads", "main", "active.jsonl"), history.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }
  return dataDir;
}

function rehydrate(messages: unknown[]): unknown[] {
  return messages.map((m, i) => {
    const msg = m as Record<string, unknown>;
    return {
      ...msg,
      msg_id: msg["msg_id"] === "<minted_id>" ? `m_rehydrated_${i}` : msg["msg_id"],
      timestamp: msg["timestamp"] === "<minted_timestamp>" ? MINTED_TS : msg["timestamp"],
    };
  });
}

describe("appendUserTurn", () => {
  for (const c of fixture.append_user_turn) {
    test(c.name, async () => {
      const root = await tempRoot();
      try {
        const input = c.input as {
          body: { image_data?: Parameters<typeof appendUserTurn>[4]["image_data"]; images?: string[]; text: string };
          history: unknown[];
          regen: boolean;
        };
        const dataDir = await seedCharacter(root, rehydrate(input["history"]));

        const srcDir = join(root, "client_files");
        await mkdir(srcDir, { recursive: true });
        const images: string[] = [];
        for (const name of input["body"].images ?? []) {
          const at = join(srcDir, name);
          await writeFile(at, PNG_BYTES);
          images.push(at);
        }

        const rec = recorder();
        const engine = await ConversationEngine.load("ada", dataDir);
        const regenAlt = await appendUserTurn(
          rec.ctx,
          engine,
          dataDir,
          "ada",
          {
            text: input["body"].text,
            images,
            image_data: input["body"].image_data ?? (input["body"].images ?? []).map((filename) => ({ filename, data: Buffer.from(PNG_BYTES).toString("base64") })),
          },
          input["regen"],
        );

        expect(shaped(regenAlt?.alternatives ?? null)).toEqual(
          shaped(c.output.regen_alt) ?? null,
        );
        expect(shaped(engine.messages())).toEqual(shaped(c.output.engine_messages));
        expect(engine.currentRevision()).toBe(c.output.revision);
        expect(shaped(rec.events)).toEqual(shaped(c.output.events));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("the user-input echo names the request that sent it", async () => {
    const root = await tempRoot();
    try {
      const dataDir = await seedCharacter(root, []);
      const rec = recorder();
      const engine = await ConversationEngine.load("ada", dataDir);
      await appendUserTurn(rec.ctx, engine, dataDir, "ada", { text: "hello", images: [], image_data: [] }, false, "send-1");
      expect(rec.events).toHaveLength(1);
      expect(rec.events[0]).toMatchObject({ type: "new_message", rid: "send-1", origin: "user_input", role: "user", content: "hello" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a minted id is a uuid and a minted timestamp is local rfc3339", () => {
    let checked = 0;
    for (const c of fixture.append_user_turn) {
      if (c.output.events.length === 0) continue;
      const observed = (c as unknown as { _observed: { msg_id: string; timestamp: string } })._observed;
      checked += 1;
      expect(observed.msg_id).toMatch(/^m_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
      expect(MINTED_ID).toMatch(/^m_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
      expect(Number.isNaN(new Date(observed.timestamp).getTime())).toBe(false);
      expect(observed.timestamp).toMatch(/[+-]\d{2}:\d{2}$/);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("ensureAndBackfillAutonomy", () => {
  for (const c of fixture.ensure_and_backfill_autonomy) {
    test(c.name, async () => {
      const root = await tempRoot();
      try {
        const input = c.input as {
          active: unknown[];
          activity_seeded?: boolean;
          archived: unknown[];
          now: string;
          state_exists: boolean;
        };
        const dataDir = await seedCharacter(root, rehydrate(input["active"]));

        const archived = rehydrate(input["archived"]);
        if (archived.length > 0) {
          const history = HistoryStore.open(join(dataDir, "shore.db"));
          try {
            history.putSegment("ada", 0, { file: "shore.db", message_count: archived.length, compacted_at: "2026-01-01T00:00:00-05:00" }, archived as Message[]);
          } finally { history.close(); }
        }

        const rec = recorder({
          ensureState: () => !input["state_exists"],
          needsActivityBackfill: () => input["activity_seeded"] !== true,
        });
        const engine = await ConversationEngine.load("ada", dataDir);

        await ensureAndBackfillAutonomy(
          rec.ctx,
          engine,
          "ada",
          stubConfig(root),
          new Date(input["now"]),
        );

        const actual = rec.backfills.map((b) => ({
          character: b.character,
          timestamps: b.timestamps.map((t) => t.getTime()).sort((a, b2) => a - b2),
        }));
        const expected = (c.output.backfill_calls as { character: string; timestamps: string[] }[]).map((b) => ({
          character: b.character,
          timestamps: b.timestamps
            .map((t) => new Date(`${t.replace(" ", "T")}Z`).getTime())
            .sort((a, b2) => a - b2),
        }));

        expect(actual.length).toBe(expected.length);
        for (const [i, call] of actual.entries()) {
          expect(call.character).toBe(required(expected[i]).character);
          expect(call.timestamps.length).toBe(required(expected[i]).timestamps.length);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe("contextTokensFor", () => {
  for (const c of fixture.context_tokens) {
    test(c.name, () => {
      const i = c.input as Record<string, number>;
      const usage = {
        input_tokens: required(i["input_tokens"]),
        output_tokens: 0,
        cache_read_tokens: required(i["cache_read_tokens"]),
        cache_creation_tokens: required(i["cache_creation_tokens"]),
      };
      expect(contextTokensFor(usage as Usage)).toBe(c.output.context_tokens);
    });
  }
});

describe("maybeCompact measures the context, not the turn's billed total", () => {
  const usage = (input: number, cacheRead: number): Usage => ({
    input_tokens: input,
    output_tokens: 500,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: 0,
  });

  function probe(result: StreamResult): Promise<number> {
    let seen = -1;
    const ctx = {
      emitEvent: () => {},
      sendDirect: () => {},
      now: () => MINTED_TS,
      newMessageId: () => MINTED_ID,
      autonomy: {
        ensureState: () => true,
        needsActivityBackfill: () => false,
        backfillActivity: () => {},
        onUserMessage: () => {},
        shouldCompactNow: (_c: string, _t: number, contextTokens: number) => {
          seen = contextTokens;
          return false;
        },
        onCompactionComplete: () => {},
        onCompactionFailed: () => {},
      },
    } as unknown as TurnContext;
    const engine = { turnCount: () => 5 } as unknown as TurnEngine;
    const runner = {
      run: () => {
        throw new Error("compaction must not run");
      },
      applyDeferredEdits: async () => {},
    };

    return maybeCompact(
      ctx,
      engine,
      "ada",
      {} as unknown as LoadedConfig,
      "/nonexistent",
      result,
      undefined,
      runner,
    ).then(() => seen);
  }

  const base: Omit<StreamResult, "usage" | "context_usage"> = {
    content: "answer",
    model: "test-model",
    finish_reason: "end_turn",
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
    tool_uses: [],
    content_blocks: [],
  };

  test("an eight-round tool loop reports the last prompt, not the sum of all eight", async () => {
    expect(
      await probe({ ...base, usage: usage(64_000, 228_660), context_usage: usage(1_775, 41_984) }),
    ).toBe(43_759);
  });

  test("a turn without a tool loop still reports its own usage", async () => {
    expect(await probe({ ...base, usage: usage(1_016, 14_848) })).toBe(15_864);
  });
});

describe("emitPostPersistStreamEnd", () => {
  for (const c of fixture.emit_post_persist_stream_end) {
    test(c.name, async () => {
      const root = await tempRoot();
      try {
        const input = c.input as { history: unknown[]; rid?: string | null };
        const dataDir = await seedCharacter(root, rehydrate(input["history"]));
        const rec = recorder();
        const engine = await ConversationEngine.load("ada", dataDir);

        const result: StreamResult = {
          content: "answer",
          model: "test-model",
          finish_reason: "stop",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          timing: { total_ms: 0, time_to_first_token_ms: 0 },
          tool_uses: [],
          content_blocks: [],
        };

        emitPostPersistStreamEnd(rec.ctx, engine, input["rid"] ?? undefined, result);

        expect(shaped(rec.direct)).toEqual(shaped(c.output.direct));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
