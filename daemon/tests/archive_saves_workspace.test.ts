import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps } from "../src/handler/deps.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { stopBackgroundCompactions } from "../src/memory/compaction/background.ts";
import { runCompaction, runCompactionPass, type CompactionRunDeps } from "../src/memory/compaction/run.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { afterFirstChat } from "./support/chat_world.ts";
import { eventsForResponse } from "./support/stream.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-11-12T10:00:00.000Z";
const SAVED = "save: changes left uncommitted when a conversation was archived";
const ROTATED = "Conversation rotated into history (2 turns, no memory write)";
const KEY_ENV = "SHORE_TEST_ARCHIVE_SAVES_KEY";

function said(id: string, role: Message["role"], text: string): Message {
  return { msg_id: id, role, content: text, images: [], alternatives: [], content_blocks: [{ type: "text", text }], timestamp: NOW };
}

function gitAt(dir: string): (...args: string[]) => string {
  return (...args) => execFileSync("git", ["-c", "user.name=Mara", "-c", "user.email=mara@example.test", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function startRepo(workspace: string, remote: string): string {
  const git = gitAt(workspace);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(workspace, "SOUL.md"), "soul\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "start");
  git("remote", "add", "origin", remote);
  git("push", "--quiet", "--set-upstream", "origin", "main");
  return git("rev-parse", "HEAD");
}

interface Kept {
  data: string;
  workspace: string;
  start: string;
  deps: CompactionRunDeps;
  notices: string[];
  git: (...args: string[]) => string;
  head: () => string;
  remoteHead: () => string;
  write: (path: string, text: string) => void;
  commit: (path: string, text: string, message: string) => string;
  archive: () => Promise<void>;
  segments: () => number;
}

async function kept(push: boolean): Promise<Kept> {
  const root = await mkdtemp(testTmp("shore-archive-saves-"));
  const data = join(root, "data");
  const workspace = join(root, "config", "characters", "ada", "workspace");
  const remote = join(root, "remote.git");
  mkdirSync(join(data, "ada", "threads", "main"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const conversation = [said("a", "user", "is the lamp lit"), said("b", "assistant", "it is"), said("c", "user", "and the door"), said("d", "assistant", "shut")];
  writeDurable(threadFile(data, "ada", "main", "active.jsonl"), conversation.map((message) => `${JSON.stringify(message)}\n`).join(""));
  const start = startRepo(workspace, remote);
  const app = defaultAppConfig();
  app.compaction.write_memory = false;
  app.compaction.keep_recent_turns = 0;
  app.compaction.git_push = push;
  const config: LoadedConfig = {
    app, models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data, cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const notices: string[] = [];
  const deps: CompactionRunDeps = {
    config,
    generate: () => Promise.reject(new Error("an archive that writes no memory asks no model")),
    notify: (_title, body) => notices.push(body),
  };
  const git = gitAt(workspace);
  const write = (path: string, text: string): void => { writeFileSync(join(workspace, path), text); };
  return {
    data, workspace, start, deps, notices, git, write,
    head: () => git("rev-parse", "HEAD"),
    remoteHead: () => execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim(),
    commit: (path, text, message) => {
      write(path, text);
      git("add", "--all");
      git("commit", "--quiet", "-m", message);
      return git("rev-parse", "HEAD");
    },
    archive: async () => {
      await runCompaction("ada", deps, "turn");
      await stopBackgroundCompactions(data, "the test is over");
    },
    segments: () => {
      const store = HistoryStore.open(join(data, HISTORY_DB_FILE));
      try {
        return store.entries("ada").length;
      } finally {
        store.close();
      }
    },
  };
}

describe("an archive that writes no memory", () => {
  test("commits what was left uncommitted in the workspace, as the character", async () => {
    const world = await kept(false);
    world.write("SOUL.md", "soul, a little older\n");
    world.write("lamp.md", "lit\n");
    await world.archive();
    expect(world.notices).toEqual([ROTATED]);
    expect(world.git("log", "-1", "--format=%an|%ae|%s")).toBe(`ada|ada@shore.local|${SAVED}`);
    expect(world.git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["SOUL.md", "lamp.md"]);
    expect(world.git("status", "--porcelain")).toBe("");
    expect(world.git("rev-parse", "HEAD~1")).toBe(world.start);
  });

  test("makes no commit when nothing was left uncommitted", async () => {
    const world = await kept(false);
    await world.archive();
    expect(world.notices).toEqual([ROTATED]);
    expect(world.head()).toBe(world.start);
  });

  test("pushes when git_push is on", async () => {
    const world = await kept(true);
    world.write("lamp.md", "lit\n");
    await world.archive();
    expect(world.head()).not.toBe(world.start);
    expect(world.remoteHead()).toBe(world.head());
  });

  test("pushes what the character committed by itself", async () => {
    const world = await kept(true);
    const own = world.commit("lamp.md", "lit\n", "the lamp");
    await world.archive();
    expect(world.head()).toBe(own);
    expect(world.remoteHead()).toBe(own);
  });

  test("commits and does not push when git_push is off", async () => {
    const world = await kept(false);
    world.write("lamp.md", "lit\n");
    await world.archive();
    expect(world.head()).not.toBe(world.start);
    expect(world.remoteHead()).toBe(world.start);
  });

  test("still archives, and still pushes, when the commit can't be made", async () => {
    const world = await kept(true);
    const own = world.commit("lamp.md", "lit\n", "the lamp");
    world.write("door.md", "shut\n");
    writeFileSync(join(world.workspace, ".git", "index.lock"), "");
    await world.archive();
    expect(world.notices).toEqual([ROTATED]);
    expect(world.segments()).toBe(1);
    expect(world.head()).toBe(own);
    expect(world.remoteHead()).toBe(own);
  });

  test("settles the thread after the archive", async () => {
    const world = await kept(false);
    const settled: string[] = [];
    world.deps.afterArchive = async (thread) => { settled.push(thread); };
    await world.archive();
    expect(settled).toEqual(["main"]);
  });

  test("as a dry run archives nothing and commits nothing", async () => {
    const world = await kept(true);
    world.write("lamp.md", "lit\n");
    const outcome = await runCompactionPass("ada", world.deps, { dryRun: true });
    await stopBackgroundCompactions(world.data, "the test is over");
    expect([outcome?.kind, outcome?.kind === "rotated" && outcome.dryRun]).toEqual(["rotated", true]);
    expect(world.segments()).toBe(0);
    expect(world.head()).toBe(world.start);
    expect(world.git("status", "--porcelain")).toBe("?? lamp.md");
  });

  test("lets a daemon that is stopping wait for the push", async () => {
    const world = await kept(true);
    world.write("lamp.md", "lit\n");
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const realRun = CharacterWorkspace.prototype.run.bind(new CharacterWorkspace(world.workspace));
    const run = spyOn(CharacterWorkspace.prototype, "run").mockImplementation(async (command, args, options) => {
      if (args.at(-1) === "push") {
        reached.resolve();
        await release.promise;
      }
      return await realRun(command, args, options);
    });
    try {
      await runCompaction("ada", world.deps, "turn");
      let stopped = false;
      const stopping = stopBackgroundCompactions(world.data, "the daemon is stopping").then(() => { stopped = true; });
      await reached.promise;
      expect(stopped).toBe(false);
      expect(world.remoteHead()).toBe(world.start);
      release.resolve();
      await stopping;
    } finally {
      release.resolve();
      run.mockRestore();
    }
    expect(world.remoteHead()).toBe(world.head());
  });
});

function conflictWith(world: Kept): void {
  world.git("checkout", "--quiet", "-b", "other");
  world.commit("SOUL.md", "theirs\n", "theirs");
  world.git("checkout", "--quiet", "main");
  world.commit("SOUL.md", "ours\n", "ours");
}

const MIDWAY: Record<string, (world: Kept) => void> = {
  "a merge": (world) => {
    conflictWith(world);
    expect(() => world.git("merge", "other")).toThrow();
  },
  "a cherry-pick": (world) => {
    conflictWith(world);
    expect(() => world.git("cherry-pick", "other")).toThrow();
  },
  "a revert": (world) => {
    world.commit("SOUL.md", "first\n", "first");
    world.commit("SOUL.md", "second\n", "second");
    expect(() => world.git("revert", "--no-edit", "HEAD~1")).toThrow();
  },
  "a rebase, with HEAD on no branch": (world) => {
    world.commit("SOUL.md", "ours\n", "ours");
    world.git("checkout", "--quiet", "--detach");
    world.write("lamp.md", "lit\n");
  },
};

describe("an archive leaves the workspace's git alone in the middle of", () => {
  for (const [name, begin] of Object.entries(MIDWAY)) {
    test(name, async () => {
      const world = await kept(true);
      begin(world);
      const head = world.head();
      const status = world.git("status", "--porcelain");
      expect(status).not.toBe("");
      await world.archive();
      expect(world.notices).toEqual([ROTATED]);
      expect(world.head()).toBe(head);
      expect(world.git("status", "--porcelain")).toBe(status);
      expect(world.remoteHead()).toBe(world.start);
    });
  }
});

function provider(): SidecarProvider {
  const answer = async (request: SidecarRequest): Promise<GenerateResponse> => ({
    model: request.model,
    content: "The lamp is lit.",
    content_blocks: [{ type: "text", text: "The lamp is lit." }],
    finish_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  });
  return { generate: answer, stream: async function* (request) { yield* eventsForResponse(await answer(request)); } };
}

function saidIn(request: SidecarRequest | undefined): string[] {
  return (request?.messages ?? []).map((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""));
}

test("clearing a conversation commits and pushes the workspace too", async () => {
  let remote = "";
  await afterFirstChat({
    name: "clear-saves", keyEnv: KEY_ENV, provider: provider(), tools: ["read"],
    tune: (app) => { app.compaction.git_push = true; },
    prepare: (workspace) => {
      remote = join(workspace, "..", "remote.git");
      startRepo(workspace, remote);
    },
  }, async ({ runtime, config, workspace }) => {
    const env = { [KEY_ENV]: "fixture-key" };
    const autonomy = new TurnAutonomyBridge(runtime.autonomy);
    autonomy.ensureState("ada", config);
    await autonomy.settled("ada");
    expect(saidIn(runtime.cache.get("ada"))).toEqual(["hello", "The lamp is lit."]);
    writeFileSync(join(workspace, "lamp.md"), "lit\n");
    const result = await dispatchCommand(buildCommandPathDeps({
      runtime, autonomy, diagnostics: new Diagnostics(), router: new SessionRouter(),
      handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env,
    }), { name: "clear", args: {} }, {
      session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "main" },
      rid: "clear",
      kind: "command",
    });
    await autonomy.settled("ada");
    await stopBackgroundCompactions(config.dirs.data, "the test is over");
    const git = gitAt(workspace);
    expect(result).toMatchObject({ data: { status: "clear", character: "ada", thread: "main" } });
    expect(runtime.autonomy.status("ada")?.covered_turn_count).toBe(0);
    expect(saidIn(runtime.cache.get("ada")).join("\n")).not.toContain("hello");
    expect(git("log", "-1", "--format=%an|%s")).toBe(`ada|${SAVED}`);
    expect(git("status", "--porcelain")).toBe("");
    expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim()).toBe(git("rev-parse", "HEAD"));
  });
});
