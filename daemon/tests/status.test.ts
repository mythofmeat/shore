import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutonomyService, HEARTBEAT_LOG_FILENAME } from "../src/autonomy/service.ts";
import type { HeartbeatClockConfig } from "../src/autonomy/heartbeat.ts";
import { STATE_FILENAME } from "../src/autonomy/state_file.ts";
import type { AutonomyActionResult, AutonomyExecutor } from "../src/autonomy/runner.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { KeepaliveService } from "../src/cache/keepalive.ts";
import { CommandError } from "../src/commands/errors.ts";
import type { ErrorCode } from "../src/protocol/ErrorCode.ts";
import {
  autonomyWire,
  errorLog,
  heartbeatLog,
  heartbeatSetActive,
  heartbeatSetDormant,
  heartbeatTickNow,
  status,
  type StatusContext,
} from "../src/commands/status.ts";

import fixture from "./commands_fixtures/status.json" with { type: "json" };

const CHARACTER = "poppy";
const TOLERANCE_SECS = fixture.tolerance_secs;

const DEFAULT_CLOCK: HeartbeatClockConfig = {
  defaultIntervalMs: 3_600_000,
  maxIdleTicks: 3,
  maxSilentMs: 172_800_000,
  minWakeIntervalMs: 3_600_000,
};

const CUSTOM_CLOCK: HeartbeatClockConfig = {
  defaultIntervalMs: 2_700_000,
  maxIdleTicks: 7,
  maxSilentMs: 90_000_000,
  minWakeIntervalMs: 1500,
};

const LOCAL_NOW = Date.UTC(2026, 7, 4, 14, 0, 0);

const IDLE_EXECUTOR: AutonomyExecutor = {
  runHeartbeatTick: async (): Promise<AutonomyActionResult> => ({ events: [] }),
  runCompaction: async (): Promise<AutonomyActionResult> => ({ events: [] }),
  runDeepArchive: async (): Promise<AutonomyActionResult> => ({ events: [] }),
};

interface Setup {
  registered?: boolean;
  persisted?: [number, number | undefined, number | undefined, number];
  log?: boolean;
  dormant?: boolean;
  paused?: boolean;
  customBounds?: boolean;
  activeModel?: string;
  configModel?: string;
  turns?: number;
  tokens?: [number, number, number, number];
  deferred?: boolean;
  activity?: "even_weeks" | "thin";
  diag?: boolean;
}

const SETUPS: Record<string, Setup> = {
  unregistered: { registered: false },
  fresh: {},
  restored: { persisted: [2, 3600, -125, 4], log: true },
  overdue: { persisted: [1, -45, -7200, 0] },
  restored_no_times: { persisted: [5, undefined, undefined, 9] },
  dormant: { persisted: [0, 1800, -60, 0], dormant: true },
  paused: { paused: true },
  future_user: { persisted: [0, undefined, 600, 0] },
  custom_bounds: { customBounds: true },
  model_override: { activeModel: "claude-sonnet", configModel: "claude-opus" },
  model_from_config: { configModel: "claude-opus" },
  model_none: {},
  turns_and_tokens: { turns: 3, tokens: [1200, 340, 9000, 512] },
  deferred_edits: { deferred: true },
  activity_week: { persisted: [0, undefined, -300, 0], activity: "even_weeks" },
  activity_thin: { persisted: [0, undefined, -300, 0], activity: "thin" },
  log_only: { log: true },
  diagnostics_seeded: { diag: true },
};

const LOG_KINDS = [
  "tick_fired",
  "tool_use",
  "message_sent",
  "tick_fired",
  "message_skipped",
  "dormant",
  "wake",
  "timeout",
  "dormant_ping",
  "recap_written",
];
const LOG_LINES = Array.from({ length: 25 }, (_, i) => ({
  timestamp: `2026-01-15T09:${String(i).padStart(2, "0")}:00+00:00`,
  kind: LOG_KINDS[i % LOG_KINDS.length],
  detail: `event ${i}`,
}));

const DEFERRED_LINES = [
  JSON.stringify({ path: "SOUL.md", timestamp: "2026-01-15T09:00:00+00:00" }),
  JSON.stringify({ path: "MEMORY.md", timestamp: "2026-01-15T09:00:01+00:00" }),
  JSON.stringify({ path: "SOUL.md", timestamp: "2026-01-15T09:00:02+00:00" }),
  JSON.stringify({ path: "memory/notes.md", timestamp: "2026-01-15T09:00:03+00:00" }),
  "{not json",
  JSON.stringify({ timestamp: "2026-01-15T09:00:04+00:00" }),
  "",
  JSON.stringify({ path: "AGENTS.md", timestamp: "2026-01-15T09:00:05+00:00" }),
];

function evenWeeks(): number[] {
  const out: number[] = [];
  for (let day = 0; day < 28; day += 1) {
    for (const hour of [9, 10, 14, 20, 21]) {
      out.push(Date.UTC(2026, 0, 5 + day, hour, 0, 0));
    }
  }
  return out;
}

const THIN = [
  Date.UTC(2026, 0, 7, 13, 0, 0),
  Date.UTC(2026, 0, 7, 13, 10, 0),
  Date.UTC(2026, 0, 7, 15, 0, 0),
  Date.UTC(2026, 0, 7, 18, 30, 0),
];

function diagEntries(d: Diagnostics): void {
  for (let i = 0; i < 12; i += 1) {
    d.errors.push({
      timestamp: `2026-01-15T12:00:${String(i).padStart(2, "0")}+00:00`,
      error_type: "llm",
      message: `failure ${i}`,
      context: `character=${CHARACTER}`,
    });
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shore-status-parity-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function build(name: string): Promise<StatusContext> {
  const s = SETUPS[name];
  if (s === undefined) throw new Error(`unknown setup ${name}`);

  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  const charData = join(dirs.data, CHARACTER);
  mkdirSync(charData, { recursive: true });

  const now = Date.now();
  const stamp = (offset: number): string =>
    new Date(now + offset * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  if (s.persisted !== undefined) {
    const [ticks, wake, user, covered] = s.persisted;
    writeFileSync(
      join(charData, STATE_FILENAME),
      JSON.stringify(
        {
          version: 4,
          ticks_without_user: ticks,
          next_wake_at: wake === undefined ? null : stamp(wake),
          last_user_at: user === undefined ? null : stamp(user),
          covered_turn_count: covered,
          keepalive_model: null,
          keepalive_interval_ms: null,
          keepalive_last_warm_at: null,
          keepalive_last_active_at: null,
        },
        null,
        2,
      ),
    );
  }
  if (s.log === true) {
    writeFileSync(
      join(charData, HEARTBEAT_LOG_FILENAME),
      LOG_LINES.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
  }
  if (s.deferred === true) {
    writeFileSync(join(charData, "deferred_edits.jsonl"), DEFERRED_LINES.map((l) => `${l}\n`).join(""));
  }

  const autonomy = new AutonomyService(IDLE_EXECUTOR);
  if (s.registered !== false) {
    await autonomy.register({
      character: CHARACTER,
      data_dir: charData,
      config: {
        autonomyEnabled: true,
        heartbeatEnabled: true,
        compactionEnabled: true,
        minTurns: 4,
        maxTurns: 20,
        idleTriggerSecs: 3600,
        archiveAfterSecs: 86_400,
        maxContextTokens: 0,
      },
      clock: s.customBounds === true ? CUSTOM_CLOCK : DEFAULT_CLOCK,
    });
    if (s.activity !== undefined) {
      const stamps = s.activity === "even_weeks" ? evenWeeks() : THIN;
      autonomy.backfillActivity(CHARACTER, stamps, stamps[stamps.length - 1]);
    }
    if (s.dormant === true) {
      expect(autonomy.forceHeartbeatState(CHARACTER, "dormant")).toBe(true);
    }
    if (s.paused === true) {
      expect(autonomy.setPaused(CHARACTER, true)).toBe(true);
    }
  }

  const diag = new Diagnostics();
  if (s.diag === true) diagEntries(diag);

  const [input, output, cacheRead, cacheWrite] = s.tokens ?? [0, 0, 0, 0];
  return {
    characterName: CHARACTER,
    turnCount: s.turns ?? 0,
    activeModel: s.activeModel,
    config: { app: { defaults: { model: s.configModel } }, dirs },
    sessionTokens: {
      input,
      output,
      cache_read: cacheRead,
      cache_write: cacheWrite,
    },
    autonomy,
    diagnostics: diag,
    now: () => Date.now(),
    localNow: () => LOCAL_NOW,
  };
}

const VOLATILE = ["next_wake_at", "seconds_until_wake", "last_user_at", "seconds_since_user"];

function detmp(value: unknown): unknown {
  if (typeof value === "string") return value.split(root).join("<tmp>");
  if (Array.isArray(value)) return value.map(detmp);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, detmp(v)]),
    );
  }
  return value;
}

function withoutVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVolatile);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !VOLATILE.includes(k))
        .map(([k, v]) => [k, withoutVolatile(v)]),
    );
  }
  return value;
}

interface Volatile {
  wake_at_secs: number | null;
  wake_until_secs: number | null;
  user_at_secs: number | null;
  user_since_secs: number | null;
}

function expectVolatile(
  autonomy: Record<string, unknown>,
  now: number,
  stampKey: string,
  secsKey: string,
  atSecs: number | null,
  countSecs: number | null,
): void {
  if (atSecs === null) {
    expect(Object.keys(autonomy)).not.toContain(stampKey);
    expect(Object.keys(autonomy)).not.toContain(secsKey);
    return;
  }
  const stamp = autonomy[stampKey];
  expect(typeof stamp).toBe("string");
  expect(stamp as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+00:00$/);
  const drift = Math.abs((Date.parse(stamp as string) - now) / 1000 - atSecs);
  expect(drift).toBeLessThanOrEqual(TOLERANCE_SECS);

  expect(Math.abs((autonomy[secsKey] as number) - (countSecs as number))).toBeLessThanOrEqual(
    TOLERANCE_SECS,
  );
}

interface StatusCase {
  case: string;
  ok: Record<string, unknown>;
  volatile: Volatile;
}

describe("status", () => {
  for (const row of fixture.status as StatusCase[]) {
    test(row.case, async () => {
      const ctx = await build(row.case);
      const now = Date.now();
      const result = detmp(await status(ctx)) as Record<string, unknown>;

      const autonomy = result["autonomy"];
      if (row.volatile.wake_at_secs !== null || row.volatile.user_at_secs !== null) {
        expect(autonomy).not.toBeNull();
      }
      if (autonomy !== null) {
        const a = autonomy as Record<string, unknown>;
        expectVolatile(
          a,
          now,
          "next_wake_at",
          "seconds_until_wake",
          row.volatile.wake_at_secs,
          row.volatile.wake_until_secs,
        );
        expectVolatile(
          a,
          now,
          "last_user_at",
          "seconds_since_user",
          row.volatile.user_at_secs,
          row.volatile.user_since_secs,
        );
      }

      expect(withoutVolatile(result)).toEqual(withoutVolatile(row.ok));
    });
  }
});

interface ArgCase {
  case: string;
  setup: string;
  args: Record<string, unknown>;
  ok: unknown;
}

describe("error_log", () => {
  for (const row of fixture.error_log as ArgCase[]) {
    test(row.case, async () => {
      const ctx = await build(row.setup);
      expect<unknown>(errorLog(ctx, row.args)).toEqual(row.ok);
    });
  }
});

describe("heartbeat_log", () => {
  for (const row of fixture.heartbeat_log as ArgCase[]) {
    test(row.case, async () => {
      const ctx = await build(row.setup);
      expect<unknown>(heartbeatLog(ctx, row.args)).toEqual(row.ok);
    });
  }
});

interface ControlCase {
  case: string;
  command: "heartbeat_tick_now" | "heartbeat_set_dormant" | "heartbeat_set_active";
  setup: string;
  ok?: unknown;
  err?: { code: ErrorCode; message: string };
  after: { heartbeat_state: string; ticks_without_user: number; wake_armed: boolean } | null;
}

const CONTROLS = {
  heartbeat_tick_now: heartbeatTickNow,
  heartbeat_set_dormant: heartbeatSetDormant,
  heartbeat_set_active: heartbeatSetActive,
} as const;

describe("heartbeat controls", () => {
  for (const row of fixture.controls as ControlCase[]) {
    test(row.case, async () => {
      const ctx = await build(row.setup);
      const run = (): unknown => CONTROLS[row.command](ctx);

      if (row.err !== undefined) {
        expect(run).toThrow(CommandError);
        try {
          run();
        } catch (e) {
          expect((e as CommandError).code).toBe(row.err.code);
          expect((e as CommandError).message).toBe(row.err.message);
        }
      } else {
        expect<unknown>(run()).toEqual(row.ok);
      }

      const after = (await status(ctx)) as { autonomy: Record<string, unknown> | null };
      if (row.after === null) {
        expect(after.autonomy).toBeNull();
        return;
      }
      const a = after.autonomy as Record<string, unknown>;
      expect(a["heartbeat_state"]).toBe(row.after.heartbeat_state);
      expect(a["ticks_without_user"]).toBe(row.after.ticks_without_user);
      expect(Object.keys(a).includes("next_wake_at")).toBe(row.after.wake_armed);
    });
  }
});

describe("the clock arithmetic", () => {
  const at = Date.UTC(2026, 0, 15, 12, 0, 0);

  function wireAt(wake: number | undefined, user: number | undefined): Record<string, unknown> {
    return autonomyWire(
      {
        character: CHARACTER,
        paused: false,
        heartbeat_state: "Active",
        ticks_without_user: 0,
        covered_turn_count: 0,
        ...(wake === undefined ? {} : { next_wake_at: wake }),
        ...(user === undefined ? {} : { last_user_at: user }),
        default_interval_ms: DEFAULT_CLOCK.defaultIntervalMs,
        max_idle_ticks: DEFAULT_CLOCK.maxIdleTicks,
        min_wake_interval_ms: DEFAULT_CLOCK.minWakeIntervalMs,
        max_silent_ms: DEFAULT_CLOCK.maxSilentMs,
        recent_events: [],
      },
      at,
    ) as Record<string, unknown>;
  }

  test("an overdue wake truncates towards zero rather than flooring", () => {
    expect(wireAt(at - 1400, undefined)["seconds_until_wake"]).toBe(-1);
    expect(wireAt(at - 400, undefined)["seconds_until_wake"]).toBe(-0);
    expect(wireAt(at + 400, undefined)["seconds_until_wake"]).toBe(0);
    expect(wireAt(at + 1400, undefined)["seconds_until_wake"]).toBe(1);
  });

  test("elapsed time truncates too, and saturates at zero", () => {
    expect(wireAt(undefined, at - 1900)["seconds_since_user"]).toBe(1);
    expect(wireAt(undefined, at + 1900)["seconds_since_user"]).toBe(0);
  });

  test("a zero fraction is omitted and a non-zero one is kept", () => {
    expect(wireAt(at, undefined)["next_wake_at"]).toBe("2026-01-15T12:00:00+00:00");
    expect(wireAt(at + 500, undefined)["next_wake_at"]).toBe("2026-01-15T12:00:00.500+00:00");
    expect(wireAt(at, undefined)["next_wake_at"]).not.toContain("Z");
  });
});

test("the autonomy projection drops the fields the CLI does not read", async () => {
  const ctx = await build("restored");
  const result = (await status(ctx)) as { autonomy: Record<string, unknown> };
  const keys = Object.keys(result.autonomy);
  expect(keys).not.toContain("character");
  expect(keys).not.toContain("covered_turn_count");
  expect(keys).toContain("dormant_after_heartbeat_turns");
  expect(keys).not.toContain("max_idle_ticks");
  expect(keys).toContain("effective_interval_secs");
  expect(keys).not.toContain("default_interval_ms");
});

test("the envelope's turn count and the activity count are different numbers", async () => {
  const ctx = await build("activity_week");
  const result = (await status({ ...ctx, turnCount: 7 })) as {
    message_count: number;
    turn_count: number;
    activity: { message_count: number; turn_count: number };
  };
  expect(result.message_count).toBe(7);
  expect(result.turn_count).toBe(7);
  expect(result.activity.message_count).toBe(140);
  expect(result.activity.turn_count).toBe(140);
});

describe("a halted keepalive reaches the status envelope", () => {
  async function haltedContext(): Promise<StatusContext> {
    const ctx = await build("restored");
    let at = 0;
    const keepalive = new KeepaliveService(
      async () => ({
        content: "",
        model: "claude-opus-4-6",
        finish_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 14_144,
        },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
        tool_uses: [],
        content_blocks: [],
      }),
      () => at,
    );
    ctx.autonomy.attachKeepalive(keepalive);
    for (let i = 0; i < 2; i += 1) {
      keepalive.arm(
        {
          model: "claude-opus-4-6",
          max_tokens: 1,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          keepalive_interval_ms: 1_000,
          context: { character: CHARACTER, call_type: "message", thinking_enabled: false },
        } as never,
        true,
      );
      at += 10_000;
      await keepalive.tick();
    }
    return ctx;
  }

  test("a healthy daemon reports no halt", async () => {
    const ctx = await build("restored");
    const result = (await status(ctx)) as Record<string, unknown>;
    expect(result["keepalive_halted"]).toBeNull();
  });

  test("a halted daemon reports the character, the reason, and when", async () => {
    const ctx = await haltedContext();
    const result = (await status(ctx)) as Record<string, unknown>;
    const halt = result["keepalive_halted"] as Record<string, unknown> | null;

    expect(halt).not.toBeNull();
    expect(halt?.["character"]).toBe(CHARACTER);
    expect(String(halt?.["reason"])).toContain("two keepalive pings in a row missed");
    expect(String(halt?.["at"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("the halt outlives every later status read", async () => {
    const ctx = await haltedContext();
    const first = (await status(ctx)) as Record<string, unknown>;
    const second = (await status(ctx)) as Record<string, unknown>;
    expect(second["keepalive_halted"]).toEqual(first["keepalive_halted"]);
  });

  test("every name in `sections` is a block the payload actually carries", async () => {
    const ctx = await build("restored");
    const result = (await status(ctx)) as Record<string, unknown>;
    const names = result["sections"] as string[];

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(Object.keys(result), `\`${name}\` is declared but not present`).toContain(name);
    }
  });

  test("a section that has not started is declared and null, never omitted", async () => {
    const ctx = await build("unregistered");
    const result = (await status(ctx)) as Record<string, unknown>;
    const names = result["sections"] as string[];

    expect(names).toContain("autonomy");
    expect(result["autonomy"]).toBeNull();
  });

  test("memory mode was a constant, so it is not reported as status", async () => {
    const ctx = await build("restored");
    const result = (await status(ctx)) as Record<string, unknown>;
    expect(Object.keys(result)).not.toContain("memory_mode");
  });
});
