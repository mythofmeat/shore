import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { compact, type CompactContext } from "../src/commands/compact.ts";
import { runIdleCompaction } from "../src/autonomy/idle_compaction.ts";
import { commandCatalogue } from "../src/commands/registry.ts";
import { operationPolicy } from "../src/operations/policy.ts";
import { required } from "../src/util/required.ts";
import { CommandError } from "../src/commands/errors.ts";

import { archiveKey, characterDataDir } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import type { LastRequestCache } from "../src/cache/last_request.ts";
import type { RebuildDeps } from "../src/cache/rebuild.ts";
import { shoreLog } from "../src/log.ts";
import { stopBackgroundCompactions } from "../src/memory/compaction/background.ts";
import { tryBeginCompaction } from "../src/memory/compaction/manager.ts";
import * as plan from "../src/memory/compaction/plan.ts";
import { compactionRunner, runCompaction, runCompactionPass } from "../src/memory/compaction/run.ts";
import { CompactionError } from "../src/memory/compaction/types.ts";
import { ensureActivePromptSnapshot, loadActivePromptFile, pendingDeferredEditPaths, queueDeferredEdit } from "../src/memory/deferred_edits.ts";
import { ensureWakesThread } from "../src/engine/threads.ts";
import { characterWorkspace } from "../src/tools/character_workspace.ts";
import * as files from "../src/storage/files.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";

const datas: string[] = [];
afterEach(async () => {
  for (const data of datas.splice(0)) await stopBackgroundCompactions(data);
});

function said(id: string, role: Message["role"], text: string, extra: Partial<Message> = {}): Message {
  return { msg_id: id, role, content: text, images: [], content_blocks: [{ type: "text", text }], timestamp: "2026-11-18T10:00:00.000Z", ...extra };
}

const TALK = [said("a", "user", "is the lamp lit"), said("b", "assistant", "it is"), said("c", "user", "and the door"), said("d", "assistant", "shut")];

const HOME_ONLY: Record<string, readonly Message[]> = { main: TALK };

async function world(threads = HOME_ONLY): Promise<{ config: LoadedConfig; data: string; archived: (thread: string) => number; active: (thread: string) => string }> {
  const root = await mkdtemp(testTmp("shore-compact-command-"));
  const data = join(root, "data");
  datas.push(data);
  mkdirSync(join(root, "config", "characters", "ada", "workspace"), { recursive: true });
  for (const [thread, messages] of Object.entries(threads)) {
    mkdirSync(join(data, "ada", "threads", thread), { recursive: true });
    writeDurable(threadFile(data, "ada", thread, "active.jsonl"), messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
  }
  const app = promptedAppConfig();
  app.compaction.keep_recent_turns = 0;
  const config: LoadedConfig = {
    app, models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data, cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  return {
    config, data,
    archived: (thread) => {
      const store = HistoryStore.open(join(data, HISTORY_DB_FILE));
      try {
        return store.entries(archiveKey("ada", thread)).length;
      } finally {
        store.close();
      }
    },
    active: (thread) => files.readDurable(threadFile(data, "ada", thread, "active.jsonl")),
  };
}

function command(config: LoadedConfig, told: string[] = []): CompactContext {
  return {
    config,
    autonomy: { onCompactionComplete: (character, retained) => { told.push(`${character} kept ${String(retained)}`); } },
    run: {},
  };
}

const engine = (thread?: string) => ({ characterName: "ada", ...(thread === undefined ? {} : { thread }), reload: async () => {} });

describe("compacting from a command", () => {
  test("archives the thread it is asked in, says what it archived and kept, and tells the wake runner only for home and only when it archived", async () => {
    const w = await world({ main: TALK, side: TALK });
    const told: string[] = [];
    expect(await compact(engine("side"), command(w.config, told), { keep_turns: 1 })).toEqual({
      status: "rotated", character: "ada", dry_run: false, compacted_turns: 1, retained_turns: 1,
    });
    expect([w.archived("side"), w.archived("main"), told]).toEqual([1, 0, []]);
    expect(await compact(engine("main"), command(w.config, told), { keep_turns: 1, dry_run: true })).toMatchObject({ dry_run: true, compacted_turns: 1 });
    expect([w.archived("main"), told]).toEqual([0, []]);
    await compact(engine(), command(w.config, told), {});
    expect([w.archived("main"), told]).toEqual([1, ["ada kept 0"]]);
  });

  test("re-points the cached request only when it archived the home thread", async () => {
    const w = await world({ main: TALK, side: TALK });
    const repointed: string[] = [];
    const ctx = { ...command(w.config), repoint: async (character: string) => { repointed.push(character); } };
    await compact(engine("side"), ctx, { keep_turns: 1 });
    expect(repointed).toEqual([]);
    await compact(engine("main"), ctx, { keep_turns: 1 });
    expect(repointed).toEqual(["ada"]);
  });

  test("says when there is nothing to compact, nothing to archive, or another compaction holds the character", async () => {
    const w = await world({ main: TALK, empty: [] });
    const refusal = async (thread: string, args: Parameters<typeof compact>[2]) => {
      const error = await rejectionOf(compact(engine(thread), command(w.config), args)) as CommandError;
      return [error.code, error.message];
    };
    expect(await refusal("empty", {})).toEqual(["invalid_request", "No messages to compact"]);
    expect(await refusal("main", { keep_turns: 9 })).toEqual(["invalid_request", "insufficient messages"]);
    const guard = tryBeginCompaction(w.data, "ada");
    try {
      expect(await refusal("main", {})).toEqual(["busy", "Compaction already running for ada"]);
    } finally {
      guard?.release();
    }
  });

  test("passes on a failure to write the archive as it is", async () => {
    const w = await world();
    const realWrite = files.writeDurable;
    const write = spyOn(files, "writeDurable").mockImplementation((path, content) => {
      if ((typeof path === "string" ? path : path.key).endsWith("active.jsonl")) throw new Error("disk full");
      realWrite(path, content);
    });
    try {
      const rejection = await rejectionOf(compact(engine("main"), command(w.config), {}));
      expect(rejection).toBeInstanceOf(CompactionError);
      expect(String(rejection)).toContain("failed to write retained messages: disk full");
    } finally {
      write.mockRestore();
    }
  });

  test("refuses the thread that keeps the wakes' working, which is only a log", async () => {
    const w = await world({ main: TALK, wakes: TALK });
    await ensureWakesThread(w.data, "ada", "2026-11-18T10:00:00.000Z");
    const error = await rejectionOf(compact(engine("wakes"), command(w.config), {})) as CommandError;
    expect([error.code, error.message]).toEqual(["invalid_request", '"wakes" is where Shore keeps the working from ada\'s wakes. It is only a log, so it is never compacted']);
    expect(w.archived("wakes")).toBe(0);
  });

  test("applies the prompt-file edits the conversation put off, so the next turn's prompt has them", async () => {
    const w = await world();
    const home = characterDataDir(w.data, "ada");
    const workspace = characterWorkspace(w.config, "ada");
    await Bun.write(join(w.config.dirs.config, "characters", "ada", "workspace", "MEMORY.md"), "the lamp is lit\n");
    await ensureActivePromptSnapshot(home, workspace, "main");
    await Bun.write(join(w.config.dirs.config, "characters", "ada", "workspace", "MEMORY.md"), "the lamp is out\n");
    await queueDeferredEdit(home, "MEMORY.md", "main");
    expect([await loadActivePromptFile(home, "MEMORY.md", "main"), await pendingDeferredEditPaths(home, "main")]).toEqual(["the lamp is lit\n", ["MEMORY.md"]]);
    await compact(engine("main"), command(w.config), { keep_turns: 1 });
    expect([await loadActivePromptFile(home, "MEMORY.md", "main"), await pendingDeferredEditPaths(home, "main")]).toEqual(["the lamp is out\n", []]);
  });

  test("a dry run only reads and asks nothing first, while compacting for real asks for the archive to be confirmed", () => {
    const operation = required(commandCatalogue().find((each) => each.name === "compact"));
    expect(operationPolicy(operation, { dry_run: true })).toMatchObject({ effects: ["read"], confirmation: "none" });
    expect([operationPolicy(operation, { dry_run: false }).confirmation, operationPolicy(operation, {}).confirmation]).toEqual(["archive", "archive"]);
  });
});

describe("an archive", () => {
  test("of a conversation with nothing in it is skipped, and one changed under its plan isn't made", async () => {
    const w = await world({ main: TALK, empty: [] });
    expect(await runCompaction("ada", { config: w.config }, { thread: "empty" })).toEqual({ kind: "skipped", reason: "empty_or_changed" });
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    const changed = spyOn(plan, "readLiveSource").mockResolvedValue(`${JSON.stringify(said("a", "user", "was the lamp lit"))}\n`);
    try {
      expect(await runCompactionPass("ada", { config: w.config }, { thread: "main" })).toBeUndefined();
      expect(w.archived("main")).toBe(0);
    } finally {
      changed.mockRestore();
      warned.mockRestore();
    }
  });

  test("takes a wake's reply at the end with the rest unless asked to keep it", async () => {
    const wake = said("e", "assistant", "a note from a wake", { origin: "autonomous" });
    const w = await world({ main: [...TALK, wake], kept: [...TALK, wake] });
    await runCompactionPass("ada", { config: w.config }, { thread: "main" });
    await runCompactionPass("ada", { config: w.config }, { thread: "kept", retainTrailingAutonomous: true });
    expect([w.active("main"), w.active("kept")]).toEqual(["", `${JSON.stringify(wake)}\n`]);
  });

  test("refuses while another compaction holds the character", async () => {
    const w = await world();
    const guard = tryBeginCompaction(w.data, "ada");
    try {
      expect(String(await rejectionOf(runCompactionPass("ada", { config: w.config }, {})))).toBe("CompactionError: Compaction already running for ada");
    } finally {
      guard?.release();
    }
  });
});

describe("an archive after a turn", () => {
  function cache() {
    const calls: unknown[][] = [];
    const fake = {
      invalidate: (character: string, reason: string) => { calls.push(["invalidate", character, reason]); },
      reprimeFromDisk: async (character: string, _data: string, _config: LoadedConfig, deps: RebuildDeps) => {
        calls.push(["reprime", character, "env" in deps ? deps.env : "no env"]);
        return { kind: "superseded" as const };
      },
    };
    return { calls, fake: fake as unknown as LastRequestCache };
  }
  const rebuild = { mcpRegistry: { toolDefsFiltered: () => [] } } as RebuildDeps;

  test("rebuilds the cached request from disk when it archived home, with the keys it was given, and leaves it alone for another thread", async () => {
    const w = await world({ main: TALK, side: TALK });
    const withEnv = cache();
    await compactionRunner({ cache: withEnv.fake, rebuild, env: { KEY: "set" } }).run("ada", w.config, "side");
    expect(withEnv.calls).toEqual([]);
    await compactionRunner({ cache: withEnv.fake, rebuild, env: { KEY: "set" } }).run("ada", w.config, "main");
    expect(withEnv.calls).toEqual([["invalidate", "ada", "compaction"], ["reprime", "ada", { KEY: "set" }]]);
    const without = cache();
    const v = await world();
    await compactionRunner({ cache: without.fake, rebuild }).run("ada", v.config, undefined);
    expect(without.calls).toEqual([["invalidate", "ada", "compaction"], ["reprime", "ada", "no env"]]);
  });

  test("an idle archive of home says how many turns it kept, and rebuilds the cached request", async () => {
    const w = await world({ main: TALK });
    const repointed = cache();
    expect(await runIdleCompaction("ada", { config: w.config, cache: repointed.fake, rebuild })).toEqual({ turnCount: 0, events: [] });
    expect(repointed.calls).toEqual([["invalidate", "ada", "idle_compaction"], ["reprime", "ada", "no env"]]);
  });

  test("with no cached request to keep, archives without trying to rebuild one", async () => {
    const w = await world();
    const warned = spyOn(shoreLog, "warn");
    try {
      expect(await compactionRunner({ rebuild }).run("ada", w.config, "main")).toEqual({ kind: "completed", retained: 0 });
      expect(warned.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("repoint"))).toEqual([]);
    } finally {
      warned.mockRestore();
    }
  });
});
