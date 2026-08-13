/**
 * Recorded cases for dispatch command.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fixture from "./commands_fixtures/dispatch.json" with { type: "json" };
import { ConversationEngine } from "../src/engine/conversation.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { AutonomyService } from "../src/autonomy/service.ts";
import {
  commandFrame,
  isCharacterless,
  runCharacterlessCommand,
  runCommand,
  type CommandDeps,
  type CommandSession,
} from "../src/commands/dispatch.ts";
import { testTmp } from "./support/tmp.ts";

/**
 * The one arm this build does not wire, and what the fixture recorded for it.
 *
 * It is injected — see the module doc on `src/commands/dispatch.ts` — so what
 * the replay can check is that the name still *routes*: an unwired arm answers
 * with its own internal error rather than falling through to "unknown command",
 * which is what a client would see if the name were simply missing from the
 * table. The recorded Rust answer is kept beside it so the day the dependency
 * lands the case is already written down.
 *
 * `compact` was the other one and is not here any more: the harness passes a
 * real compaction runtime, so the recorded answer — the assembly failing on an
 * API key that is not set — is compared like every other case.
 */
const UNWIRED: Record<string, string> = {
  // Rust: command_output {character, reason, status} — the skip a daemon with
  // no LLM client produces.
  keepalive_ping_now: "keepalive_ping_now is not available in this build",
};

/**
 * Names whose *message* the two sides spell differently, with the reason. The
 * code is still compared; only the text is let go.
 */
const DIVERGENT: Record<string, string> = {
  // The Rust reached the ledger and let its client report the missing file;
  // this side refuses before the call, because a `usage` with no ledger path is
  // a wiring fault rather than a query that failed.
  usage: "the missing-ledger refusal moved in front of the call",
};

/**
 * Keys this side answers with that the Rust had no counterpart for.
 *
 * `keepalive_halted` reports the double-miss tripwire, which did not exist in
 * the Rust at all. The halt stops every keepalive for the life of the daemon
 * and has no clearing path, so it has to appear on a surface someone reads
 * rather than only in the daemon log.
 */
const ADDED_KEYS: Record<string, readonly string[]> = {
  status: ["keepalive_halted"],
};

function withoutAddedKeys(name: string, keys: readonly string[]): string[] {
  const added = new Set(ADDED_KEYS[name] ?? []);
  return keys.filter((key) => !added.has(key));
}

function withoutAddedShape(name: string, shape: unknown): unknown {
  const added = ADDED_KEYS[name];
  if (added === undefined || typeof shape !== "object" || shape === null) return shape;
  const rest = { ...(shape as Record<string, unknown>) };
  for (const key of added) delete rest[key];
  return rest;
}

/**
 * Names whose *outcome* changed, not just its wording.
 *
 * `config` is the only one. The recorded case reads `behavior.autonomy.enabled`
 * and the Rust answered `not_found`, because its read arm took a top-level
 * section name and nothing else — while its write arm took dotted keys and
 * nothing else. #30 made read walk dots, so the key the fixture recorded as
 * absent is now one of the ones that resolves.
 *
 * The fixture keeps the Rust's answer; what is asserted here is the new one,
 * and that the fixture still holds the old — so a regression that reinstates
 * the split grammar fails rather than passing quietly.
 */
const NOW_RESOLVES: Record<string, { was: string; value: unknown }> = {
  config: {
    was: "Config section not found: behavior.autonomy.enabled",
    // Read from the defaults rather than written down: the harness config is
    // the default one, and the point of the case is that the walk reaches the
    // leaf, not what the leaf happens to hold.
    value: defaultAppConfig().behavior.autonomy.enabled,
  },
};

/** The conversation every case runs against. */
const SEEDED = [
  ["m_1", "user", "first question"],
  ["m_2", "assistant", "first answer"],
  ["m_3", "user", "second question"],
].map(([id, role, text]) => ({
  msg_id: id,
  role,
  content: text,
  images: [],
  content_blocks: [{ type: "text", text }],
  alternatives: [],
  timestamp: "2026-01-01T10:00:00-05:00",
}));

/** The one model in the catalog, named as `defaults.model`. */
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

// ── harness ─────────────────────────────────────────────────────────────

async function tempRoot(): Promise<string> {
  return await mkdtemp(testTmp("shore-dispatch-"));
}

async function harness(): Promise<{
  engine: ConversationEngine;
  session: CommandSession;
  deps: CommandDeps;
  config: LoadedConfig;
}> {
  const root = await tempRoot();
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  await mkdir(join(dirs.data, "ada"), { recursive: true });

  // The same non-empty world the generator built, and for the same reason: on
  // an empty one, half these commands answer identically to their neighbours.
  for (const name of ["aaron", "ada", "bob"]) {
    const workspace = join(dirs.config, "characters", name, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), `# ${name}`);
  }
  const memoryDir = join(dirs.config, "characters", "ada", "workspace", "memory");
  await mkdir(join(memoryDir, "daily"), { recursive: true });
  await writeFile(join(memoryDir, "daily", "2026-01-01.md"), "# a day\n\nsomething happened\n");
  await writeFile(join(memoryDir, "boats.md"), "# boats\n\nthey float\n");
  await writeFile(
    join(dirs.data, "ada", "active.jsonl"),
    SEEDED.map((m) => JSON.stringify(m)).join("\n") + "\n",
  );

  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", FIXTURE_MODEL);

  const config: LoadedConfig = {
    app,
    models,
    providers: ProviderRegistry.empty(),
    dirs,
    rawTable: undefined,
  };

  const engine = await ConversationEngine.load("ada", dirs.data, undefined);

  const session: CommandSession = {
    config,
    configPath: join(dirs.config, "config.toml"),
    dataDir: dirs.data,
    characterName: "ada",
    activeModel: undefined,
    activeResolvedModel: undefined,
    runtime: {
      reloadRuntimeConfig: () => {},
      setUsageConfig: () => {},
      setCacheKeepaliveCeiling: () => {},
      notifyPromptSnapshotRefreshed: () => {},
    },
  };

  const deps: CommandDeps = {
    sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    // No executor is reachable here: every autonomy-backed command in the
    // fixture answers from the service's own state, and the ones that would
    // run an action fail on "no autonomy state for character" first.
    autonomy: await autonomyWithState(dirs.data),
    diagnostics: new Diagnostics(),
    callStore: undefined,
    ledgerPath: undefined,
    now: () => 0,
    localNow: () => 0,
    // A real compaction runtime, so `compact` reaches the assembly and fails
    // where the Rust did: rebuilding the chat-shape prefix needs the fixture
    // model's `SHORE_FIXTURE_API_KEY`, which is not set. `generate` is never
    // called — the request is never built — and throws if it somehow is.
    compaction: {
      run: {
        generate: () => {
          throw new Error("the fixture never gets far enough to make a call");
        },
      },
    },
  };

  return { engine, session, deps, config };
}

/**
 * An autonomy service that already has state for `ada`, as the generator's
 * manager did — without it the three heartbeat commands refuse before they
 * reach anything this table decides.
 */
async function autonomyWithState(dataDir: string): Promise<AutonomyService> {
  const service = new AutonomyService(
    { run: async () => ({ ok: false, detail: "unwired" }) } as never,
  );
  const a = defaultAppConfig().behavior.autonomy;
  await service.register({
    character: "ada",
    data_dir: join(dataDir, "ada"),
    config: {
      autonomyEnabled: a.enabled,
      heartbeatEnabled: a.heartbeat.enabled,
      compactionEnabled: defaultAppConfig().memory.compaction.enabled,
      minTurns: defaultAppConfig().memory.compaction.min_turns,
      maxTurns: defaultAppConfig().memory.compaction.max_turns,
      idleTriggerSecs: 3600,
      archiveAfterSecs: 86_400,
      maxContextTokens: 0,
    },
    clock: {
      defaultIntervalMs: 3_600_000,
      maxIdleTicks: 3,
      maxSilentMs: 172_800_000,
      minWakeIntervalMs: 3_600_000,
    },
  });
  return service;
}

/** The envelope shape the generator recorded. */
function envelope(frame: ReturnType<typeof commandFrame>): Record<string, unknown> {
  if (frame.type === "command_output" || frame.type === "error") {
    if (frame.type === "error") {
      return { kind: "error", code: frame.code, message: frame.message };
    }
    const data = frame.data;
    const isObject = typeof data === "object" && data !== null && !Array.isArray(data);
    // A stored message carries `alternatives` and the Rust omits it when empty
    // (`skip_serializing_if`), so an answer that embeds one has a key the
    // recorded side does not. Same treatment the other parity replays apply.
    const record = isObject
      ? Object.fromEntries(
          Object.entries(data as Record<string, unknown>).filter(
            ([k, v]) => !(k === "alternatives" && Array.isArray(v) && v.length === 0),
          ),
        )
      : {};
    return {
      kind: "command_output",
      name: frame.name,
      data_keys: Object.keys(record).sort(),
      data_shape: isObject
        ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, typeName(v, k)]))
        : typeName(data),
    };
  }
  return { kind: "unexpected" };
}

/**
 * The generator's `type_name`, in serde_json's vocabulary rather than
 * JavaScript's, plus its four discriminators — see the fixture's own note.
 */
function typeName(v: unknown, key?: string): string {
  if (v === null || v === undefined) return "null";
  if (key === "status" && typeof v === "string") return `status:${v}`;
  if (typeof v === "number") return `number:${v}`;
  if (Array.isArray(v)) {
    const names = namesOf(v);
    return names === undefined ? `array[${v.length}]` : `array[${names.join(",")}]`;
  }
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "string";
  return "object";
}

/** The `name` of every element, when every element has one. */
function namesOf(items: unknown[]): string[] | undefined {
  if (items.length === 0) return undefined;
  const names: string[] = [];
  for (const item of items) {
    const name =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)["name"]
        : undefined;
    if (typeof name !== "string") return undefined;
    names.push(name);
  }
  return names;
}

async function run(
  name: string,
  args: unknown,
): Promise<{ frame: ReturnType<typeof commandFrame>; activeModelAfter: string | undefined }> {
  const { engine, session, deps } = await harness();
  let frame: ReturnType<typeof commandFrame>;
  try {
    frame = commandFrame(name, { ok: await runCommand(engine, session, deps, { rid: null, name, args }) });
  } catch (e) {
    frame = commandFrame(name, { err: e });
  }
  return { frame, activeModelAfter: session.activeModel };
}

// ── dispatch ────────────────────────────────────────────────────────────

describe("runCommand", () => {
  test("the fixture key is unset, which the compact arm's expected error depends on", () => {
    expect(process.env["SHORE_FIXTURE_API_KEY"]).toBeUndefined();
  });

  for (const c of fixture.dispatch) {
    test(c.name === "" ? "(the empty name)" : c.name, async () => {
      const { frame, activeModelAfter } = await run(c.name, c.args);
      const got = envelope(frame);
      const want = c.output as Record<string, unknown>;

      const unwired = UNWIRED[c.name];
      if (unwired !== undefined) {
        expect(got["kind"]).toBe("error");
        expect(got["code"]).toBe("internal_error");
        expect(got["message"]).toBe(unwired);
        return;
      }

      const resolves = NOW_RESOLVES[c.name];
      if (resolves !== undefined) {
        expect(want["message"]).toBe(resolves.was);
        expect(got["kind"]).toBe("command_output");
        // The value itself, not just the shape: what the read arm now returns
        // for a dotted key is the point, and a shape check would pass on any
        // scalar.
        const data = frame.type === "command_output" ? (frame.data as Record<string, unknown>) : {};
        expect(data["key"]).toBe(c.args?.["key"] as never);
        expect(data["config"]).toEqual(resolves.value as never);
        return;
      }

      expect(got["kind"]).toBe(want["kind"] as string);
      if (want["kind"] === "error") {
        expect(got["code"]).toBe(want["code"] as never);
        if (DIVERGENT[c.name] === undefined) {
          expect(got["message"]).toBe(want["message"] as string);
        }
      } else {
        expect(got["name"]).toBe(want["name"] as string);
        expect(withoutAddedKeys(c.name, got["data_keys"] as string[])).toEqual(
          want["data_keys"] as string[],
        );
        expect(withoutAddedShape(c.name, got["data_shape"])).toEqual(want["data_shape"]);
      }

      // The four arms that write the active model back through the context.
      expect(activeModelAfter ?? null).toEqual(c.active_model_after ?? null);
    });
  }
});

// ── dispatch_characterless ──────────────────────────────────────────────

describe("runCharacterlessCommand", () => {
  for (const c of fixture.dispatch_characterless) {
    test(c.name, async () => {
      const { session, deps } = await harness();
      // The characterless path has no character, which is what makes
      // `list_characters` list in discovery order rather than active-first.
      session.characterName = undefined;

      const want = c.output as Record<string, unknown>;
      // The generator gave both sections the same arguments per name; only the
      // dispatch section recorded them, so they are read back from there.
      const args = fixture.dispatch.find((d) => d.name === c.name)?.args ?? {};
      try {
        const data = runCharacterlessCommand(session, deps, {
          rid: null,
          name: c.name,
          args,
        });
        expect(want["kind"]).toBe("ok");
        const record = (data ?? {}) as Record<string, unknown>;
        expect(withoutAddedKeys(c.name, Object.keys(record).sort())).toEqual(
          want["data_keys"] as string[],
        );
        expect(
          Object.fromEntries(Object.entries(record).map(([k, v]) => [k, typeName(v, k)])),
        ).toEqual(want["data_shape"] as Record<string, string>);
      } catch (e) {
        expect(want["kind"]).toBe("err");
        const frame = commandFrame(c.name, { err: e });
        expect(frame.type).toBe("error");
        if (frame.type === "error") {
          expect(frame.code).toBe(want["code"] as never);
          expect(frame.message).toBe(want["message"] as string);
        }
      }
    });
  }

  test("the accepted names are exactly the ones isCharacterless reports", () => {
    // Not fixture-driven: the Rust asked the question by falling through the
    // match, so there was no predicate to record. The handler needs one — it
    // routes before it has an engine — and the two lists agreeing is what
    // stops a name being characterless in one place and not the other.
    // Accepted means "not refused for wanting a character" — a name can be
    // accepted and still fail, which `list_provider_models` does here.
    const refused = (c: (typeof fixture.dispatch_characterless)[number]): boolean => {
      const out = c.output as Record<string, unknown>;
      return (
        out["kind"] === "err" &&
        typeof out["message"] === "string" &&
        out["message"].includes("requires a character")
      );
    };
    const accepted = fixture.dispatch_characterless.filter((c) => !refused(c)).map((c) => c.name);
    for (const name of accepted) expect(isCharacterless(name)).toBe(true);
    for (const c of fixture.dispatch_characterless) {
      if (!accepted.includes(c.name)) expect(isCharacterless(c.name)).toBe(false);
    }
  });
});
