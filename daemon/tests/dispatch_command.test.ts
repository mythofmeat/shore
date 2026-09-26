import { writeDurable } from "../src/storage/files.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fixture from "./command_captures/dispatch.json" with { type: "json" };
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
import { SnapshotGate } from "../src/snapshot_gate.ts";
import { CharacterRegistry } from "../src/characters.ts";

const UNWIRED: Record<string, string> = {
  keepalive_ping_now: "keepalive_ping_now is not available in this build",
};

const CLOSED_INPUT_ERRORS: Record<string, string> = {
  model_info: "arguments must NOT have additional properties",
  switch_model: "arguments must NOT have additional properties",
  log: "arguments must NOT have additional properties",
  delete: "Missing required argument: refs; arguments must NOT have additional properties",
  inject_system: "Missing required argument: text; arguments must NOT have additional properties",
};

const NOW_RESOLVES: Record<string, { was: string; value: unknown }> = {
  config: {
    was: "Config section not found: heartbeat.enabled",
    value: defaultAppConfig().behavior.autonomy.enabled,
  },
};

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
  await mkdir(join(dirs.data, "ada", "threads", "main"), { recursive: true });

  for (const name of ["aaron", "ada", "bob"]) {
    const workspace = join(dirs.config, "characters", name, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), `# ${name}`);
  }
  const memoryDir = join(dirs.config, "characters", "ada", "workspace", "memory");
  await mkdir(join(memoryDir, "daily"), { recursive: true });
  await writeFile(join(memoryDir, "daily", "2026-01-01.md"), "# a day\n\nsomething happened\n");
  await writeFile(join(memoryDir, "boats.md"), "# boats\n\nthey float\n");
  writeDurable(join(dirs.data, "ada", "threads", "main", "active.jsonl"), SEEDED.map((m) => JSON.stringify(m)).join("\n") + "\n");

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
    runtime: {
      reloadRuntimeConfig: () => {},
      adoptGlobalConfig: () => {},
      notifyPromptSnapshotRefreshed: () => {},
    },
  };

  const deps: CommandDeps = {
    autonomy: await autonomyWithState(dirs.data),
    diagnostics: new Diagnostics(),
    callStore: undefined,
    ledgerPath: undefined,
    now: () => 0,
    localNow: () => 0,
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
      heartbeatEnabled: a.enabled,
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
      minIntervalMs: 3_600_000,
      maxIntervalMs: 48 * 3_600_000,
    },
  });
  return service;
}

function envelope(frame: ReturnType<typeof commandFrame>): Record<string, unknown> {
  if (frame.type === "command_output" || frame.type === "error") {
    if (frame.type === "error") {
      return { kind: "error", code: frame.code, message: frame.message };
    }
    const data = frame.data;
    const isObject = typeof data === "object" && data !== null && !Array.isArray(data);
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

async function run(name: string, args: unknown): Promise<ReturnType<typeof commandFrame>> {
  const { engine, session, deps } = await harness();
  try {
    return commandFrame(name, { ok: await runCommand(engine, session, deps, { rid: null, name, args }) });
  } catch (e) {
    return commandFrame(name, { err: e });
  }
}

describe("runCommand", () => {
  test("the fixture key is unset, which the compact arm's expected error depends on", () => {
    expect(process.env["SHORE_FIXTURE_API_KEY"]).toBeUndefined();
  });

  for (const c of fixture.dispatch) {
    test(c.name === "" ? "(the empty name)" : c.name, async () => {
      const frame = await run(c.name, c.args);
      const got = envelope(frame);
      const want = c.output as Record<string, unknown>;

      const closedInputError = CLOSED_INPUT_ERRORS[c.name];
      if (closedInputError !== undefined) {
        expect(got).toEqual({ kind: "error", code: "invalid_request", message: closedInputError });
        return;
      }

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
        const data = frame.type === "command_output" ? (frame.data as Record<string, unknown>) : {};
        expect(data["key"]).toBe(c.args?.["key"]);
        expect(data["config"]).toEqual(resolves.value as never);
        return;
      }

      expect(got["kind"]).toBe(want["kind"] as string);
      if (want["kind"] === "error") {
        expect(got["code"]).toBe(want["code"] as never);
        expect(got["message"]).toBe(want["message"] as string);
      } else {
        expect(got["name"]).toBe(want["name"] as string);
        expect(got["data_keys"]).toEqual(c.name === "reset_model" ? [...want["data_keys"] as string[], "target"].sort() : want["data_keys"] as string[]);
        expect(got["data_shape"]).toMatchObject(want["data_shape"] as object);
        if (c.name === "reset_model") expect(frame).toMatchObject({ type: "command_output", data: { target: "character" } });
      }
    });
  }

  test("valid log arguments preserve the independently captured result shape", async () => {
    const captured = fixture.dispatch.find((entry) => entry.name === "log");
    expect(captured).toBeDefined();
    expect<unknown>(envelope(await run("log", {}))).toEqual(captured?.output);
  });

  test("valid model inspection retains the captured fields while selection reports its target", async () => {
    const captured = fixture.dispatch.find((entry) => entry.name === "model_info");
    expect(captured).toBeDefined();
    const info = await run("model_info", {});
    expect(envelope(info)).toMatchObject(captured?.output as object);
    expect(info).toMatchObject({ type: "command_output", data: { supports_images: null } });
    expect(await run("switch_model", {})).toMatchObject({ type: "command_output", data: { target: "current", active: "chat.fixture" } });
    expect(await run("switch_model", { name: "fixture" })).toMatchObject({ type: "command_output", data: { target: "character", qualified_name: "chat.fixture", changed: true } });
  });

  test("registered log retains role and message-count filters", async () => {
    const frame = await run("log", { count: 2, role: "assistant" });
    expect(frame).toMatchObject({ type: "command_output", data: { messages: [{ msg_id: "m_2", content: "first answer" }] } });
  });
});

describe("runCharacterlessCommand", () => {
  for (const c of fixture.dispatch_characterless) {
    test(c.name, async () => {
      const { session, deps } = await harness();
      session.characterName = undefined;

      const want = c.output as Record<string, unknown>;
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

const rejected = (work: Promise<unknown>): Promise<boolean> =>
  work.then(
    () => false,
    () => true,
  );

describe("an exclusive command whose client disconnects while it waits for the snapshot", () => {
  async function wired(signal: AbortSignal): Promise<{
    engine: ConversationEngine;
    session: CommandSession;
    deps: CommandDeps;
    gate: SnapshotGate;
    registry: CharacterRegistry;
  }> {
    const { engine, session, deps, config } = await harness();
    const gate = new SnapshotGate();
    const registry = await CharacterRegistry.create(
      config.dirs.config,
      config.dirs.data,
      config,
    );
    session.signal = signal;
    return {
      engine,
      session,
      gate,
      registry,
      deps: {
        ...deps,
        threads: registry,
        archive: {
          dirs: config.dirs,
          hasCharacter: (name: string) => registry.hasCharacter(name),
          withSnapshot: async <T>(work: () => Promise<T>) => await gate.withSnapshot(work),
          refreshDiscovery: async () => undefined,
          releaseCharacter: async () => undefined,
        },
      },
    };
  }

  test("a fork abandoned behind the gate does not create the thread", async () => {
    const controller = new AbortController();
    const { engine, session, deps, gate, registry } = await wired(controller.signal);

    let releaseReader = (): void => undefined;
    const readerHeld = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    const reader = gate.withActivity(async () => {
      await readerHeld;
    });

    const forking = rejected(
      runCommand(engine, session, deps, {
        rid: null,
        name: "fork_thread",
        args: { name: "spin" },
      }),
    );

    controller.abort();
    releaseReader();
    await reader;
    expect(await forking).toBe(true);

    expect(registry.listThreads("ada").map((t) => t.id)).not.toContain("spin");
  });

  test("the same fork succeeds when the client stays", async () => {
    const { engine, session, deps, registry } = await wired(new AbortController().signal);

    await runCommand(engine, session, deps, {
      rid: null,
      name: "fork_thread",
      args: { name: "spin" },
    });

    expect(registry.listThreads("ada").map((t) => t.id)).toContain("spin");
  });
});
