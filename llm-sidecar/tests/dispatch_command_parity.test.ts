/**
 * Replay of the command table against the frozen Rust fixture.
 *
 * `tests/commands_fixtures/dispatch_parity.json` was generated in a worktree at
 * `9023b46d` by driving the real `commands::dispatch`,
 * `dispatch_characterless` and `engine_err`. Nothing regenerates it; a diff
 * here is a defect in `src/commands/dispatch.ts`, not a fixture to refresh.
 *
 * # What is compared, and what is not
 *
 * The routing, not the payload. Every handler behind this table has its own
 * frozen fixture, so a success is compared on its top-level keys and their JSON
 * types and a failure on its code and message. That is enough to catch the
 * failure this file exists for — an arm reaching the wrong handler — without
 * duplicating ten other fixtures.
 *
 * A handful of messages differ between the two sides for reasons that are not
 * this table's: a command whose own port deliberately changed its wording, or
 * an error the TypeScript raises earlier than the Rust could. Each is listed in
 * {@link DIVERGENT} with its reason, and those cases compare the code alone.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import fixture from "./commands_fixtures/dispatch_parity.json" with { type: "json" };
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

/**
 * The two arms this build does not wire, and what the fixture recorded for each.
 *
 * Both are injected — see the module doc on `src/commands/dispatch.ts` — so what
 * the replay can check is that the name still *routes*: an unwired arm answers
 * with its own internal error rather than falling through to "unknown command",
 * which is what a client would see if the name were simply missing from the
 * table. The recorded Rust answer is kept beside each so the day the dependency
 * lands the case is already written down.
 */
const UNWIRED: Record<string, string> = {
  // Rust: invalid_request "No messages to compact" — the empty-conversation
  // guard, which fires before any of the compaction assembly runs.
  compact: "compact is not available in this build",
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
  return await mkdtemp(join(tmpdir(), "shore-dispatch-"));
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

      expect(got["kind"]).toBe(want["kind"] as string);
      if (want["kind"] === "error") {
        expect(got["code"]).toBe(want["code"] as never);
        if (DIVERGENT[c.name] === undefined) {
          expect(got["message"]).toBe(want["message"] as string);
        }
      } else {
        expect(got["name"]).toBe(want["name"] as string);
        expect(got["data_keys"]).toEqual(want["data_keys"] as string[]);
        expect(got["data_shape"]).toEqual(want["data_shape"]);
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
        expect(Object.keys(record).sort()).toEqual(want["data_keys"] as string[]);
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
