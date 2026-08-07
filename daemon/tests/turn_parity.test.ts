/**
 * Replay of the turn driver against the frozen Rust fixture.
 *
 * `tests/handler_fixtures/turn_parity.json` was generated in a worktree at
 * `9023b46d` by driving the real `append_user_turn`,
 * `ensure_and_backfill_autonomy`, `context_tokens_for` and
 * `emit_post_persist_stream_end`. Nothing regenerates it; a diff here is a
 * defect in `src/handler/turn.ts`, not a fixture to refresh.
 *
 * Three values are minted inside the code under test and are normalised in the
 * fixture — the message id, the timestamp, and the attachment path. This file
 * injects fixed generators for the first two and normalises the third the same
 * way the generator did, then pins the *shape* of all three against the real
 * samples the fixture kept under `_observed`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import fixture from "./handler_fixtures/turn_parity.json" with { type: "json" };
import { ConversationEngine } from "../src/engine/conversation.ts";
import type { Message } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { StreamResult } from "../src/llm/stream.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import {
  appendUserTurn,
  contextTokensFor,
  emitPostPersistStreamEnd,
  ensureAndBackfillAutonomy,
  type TurnAutonomy,
  type TurnContext,
} from "../src/handler/turn.ts";

const MINTED_ID = "m_00000000-0000-4000-8000-000000000000";
const MINTED_TS = "2026-01-01T00:00:00-05:00";

// ── normalisation, mirroring the generator ──────────────────────────────

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

/** `m_<uuid v4>` — a minted id, as opposed to one a case seeded. Only minted
 *  ids are normalised, so "the last message" and "the first" stay apart. */
const MINTED_ID_RE = /^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "msg_id" && typeof val === "string" && MINTED_ID_RE.test(val)) {
        out[k] = "<minted_id>";
      } else if (k === "timestamp" && val === MINTED_TS) {
        // The generator normalised by proximity to its own clock; this side
        // injects one fixed value, so equality is the same test.
        out[k] = "<minted_timestamp>";
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

/**
 * Drop keys the Rust omits via `skip_serializing_if`, so a TypeScript object
 * carrying an explicit `undefined`/`null` compares equal to a frame the Rust
 * simply did not write. Same treatment the other parity replays apply.
 */
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

// ── harness ─────────────────────────────────────────────────────────────

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
  await mkdir(charDir, { recursive: true });
  if (history.length > 0) {
    await writeFile(
      join(charDir, "active.jsonl"),
      history.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
  }
  return dataDir;
}

/** The fixture stores history with the two minted fields already normalised;
 *  put concrete values back so the engine can load them. */
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

// ── append_user_turn ────────────────────────────────────────────────────

describe("appendUserTurn", () => {
  for (const c of fixture.append_user_turn) {
    test(c.name, async () => {
      const root = await tempRoot();
      try {
        const input = c.input as Record<string, any>;
        const dataDir = await seedCharacter(root, rehydrate(input["history"]));

        // Legacy `images` are absolute client-side paths. The fixture records
        // the bare names it was given; recreate the files and point at them.
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
            image_data: input["body"].image_data ?? [],
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

  test("the minted id and timestamp match the shapes the Rust produced", () => {
    // Normalisation hides these, so pin them against the real samples the
    // generator kept rather than letting the sentinels stand in for anything.
    let checked = 0;
    for (const c of fixture.append_user_turn) {
      // `_observed` reads the conversation's last message, so on a case that
      // appended nothing it holds a *seeded* id rather than a minted one.
      // Those cases have no `new_message` to their name; skip them.
      if (c.output.events.length === 0) continue;
      const observed = (c as Record<string, any>)["_observed"];
      checked += 1;
      expect(observed.msg_id).toMatch(/^m_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
      expect(MINTED_ID).toMatch(/^m_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
      expect(Number.isNaN(new Date(observed.timestamp).getTime())).toBe(false);
      expect(observed.timestamp).toMatch(/[+-]\d{2}:\d{2}$/);
    }
    // The skip above must not quietly empty this test out.
    expect(checked).toBeGreaterThan(0);
  });
});

// ── ensure_and_backfill_autonomy ────────────────────────────────────────

describe("ensureAndBackfillAutonomy", () => {
  for (const c of fixture.ensure_and_backfill_autonomy) {
    test(c.name, async () => {
      const root = await tempRoot();
      try {
        const input = c.input as Record<string, any>;
        const dataDir = await seedCharacter(root, rehydrate(input["active"]));
        const charDir = join(dataDir, "ada");

        const archived = rehydrate(input["archived"]);
        if (archived.length > 0) {
          await mkdir(join(charDir, "segments"), { recursive: true });
          await writeFile(
            join(charDir, "segments", "0001.jsonl"),
            archived.map((m) => JSON.stringify(m)).join("\n") + "\n",
          );
          await writeFile(
            join(charDir, "compaction.json"),
            JSON.stringify({
              segments: [
                {
                  file: "0001.jsonl",
                  message_count: archived.length,
                  compacted_at: "2026-01-01T00:00:00-05:00",
                },
              ],
              total_compacted_messages: archived.length,
            }),
          );
        }

        const rec = recorder({ ensureState: () => !input["state_exists"] });
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
          // The Rust records naive local datetimes; compare on the instant,
          // which is what both sides actually selected.
          timestamps: b.timestamps.map((t) => t.getTime()).sort((a, b2) => a - b2),
        }));
        const expected = (c.output.backfill_calls as any[]).map((b) => ({
          character: b.character,
          timestamps: (b.timestamps as string[])
            .map((t) => new Date(`${t.replace(" ", "T")}Z`).getTime())
            .sort((a, b2) => a - b2),
        }));

        expect(actual.length).toBe(expected.length);
        for (const [i, call] of actual.entries()) {
          expect(call.character).toBe(expected[i]!.character);
          expect(call.timestamps.length).toBe(expected[i]!.timestamps.length);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

// ── context token sum ───────────────────────────────────────────────────

describe("contextTokensFor", () => {
  for (const c of fixture.context_tokens) {
    test(c.name, () => {
      const i = c.input as Record<string, number>;
      const usage = {
        input_tokens: i["input_tokens"]!,
        output_tokens: 0,
        cache_read_tokens: i["cache_read_tokens"]!,
        cache_creation_tokens: i["cache_creation_tokens"]!,
      };
      expect(contextTokensFor(usage as any)).toBe(c.output.context_tokens);
    });
  }
});

// ── emit_post_persist_stream_end ────────────────────────────────────────

describe("emitPostPersistStreamEnd", () => {
  for (const c of fixture.emit_post_persist_stream_end) {
    test(c.name, async () => {
      const root = await tempRoot();
      try {
        const input = c.input as Record<string, any>;
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
        } as unknown as StreamResult;

        emitPostPersistStreamEnd(rec.ctx, engine, input["rid"] ?? undefined, result);

        expect(shaped(rec.direct)).toEqual(shaped(c.output.direct));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

/** The 1x1 red PNG the generator wrote for its legacy-path cases. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
