import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { deleteCharacter, exportCharacter, importCharacter, type ArchiveContext } from "../src/commands/archive.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { Ledger } from "../src/ledger/store.ts";
import { stdioLaunch } from "../src/mcp/client.ts";
import { loadPromptFileFromWorkspace } from "../src/memory/deferred_edits.ts";
import { writeDurable } from "../src/storage/files.ts";
import type { BashResult } from "../src/tools/bash.ts";
import { canSwitchUser, characterUser, type CharacterUser } from "../src/tools/character_user.ts";
import { CharacterWorkspace, closeWorkspaceHelpers } from "../src/tools/character_workspace.ts";
import { dispatchTool, dispatchWithinDeadline, type ToolContext } from "../src/tools/dispatch.ts";
import { ensureWorkspaceGitRepo, gitCommitAll, gitHead } from "../src/tools/workspace.ts";
import { recordTurn, redoTurns, snapshotTree, undoTurns, type WorkspaceTurns } from "../src/tools/workspace_turns.ts";
import { setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

const ROOT = process.env["SHORE_ISOLATION_ROOT"] ?? "";
const USER = process.env["SHORE_ISOLATION_USER"] ?? "";
const OTHER = process.env["SHORE_ISOLATION_OTHER_USER"] ?? "";
const READY = ROOT !== "" && USER !== "" && OTHER !== "" && canSwitchUser();
const SECRET = join(ROOT, "config", "token");
const PATCH_HELPER = join(import.meta.dir, "..", "dist", "shore-apply-patch");

afterAll(() => {
  closeWorkspaceHelpers();
});

async function ownUser(): Promise<CharacterUser> {
  return await characterUser(USER);
}

async function privateDir(name: string): Promise<string> {
  const dir = testTmp(`${name}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  return dir;
}

async function freshWorkspace(passEnv: string[] = [], root = join(ROOT, "workspace", USER)): Promise<CharacterWorkspace> {
  const parent = new CharacterWorkspace(root, { user: USER, passEnv });
  const dir = join(root, randomUUID());
  await parent.call("mkdir", { path: dir });
  return parent.at(dir);
}

async function context(workspace: CharacterWorkspace): Promise<ToolContext> {
  const data = await privateDir("isolation-data");
  return {
    workspaceDir: workspace.dir, workspace, characterName: "Ada", characterDataDir: join(data, "ada"),
    imageDir: data, conversationDir: data, historyDbPath: join(data, "shore.db"), configDir: data,
  };
}

async function bash(workspace: CharacterWorkspace, command: string): Promise<BashResult> {
  return await dispatchTool("bash", { command }, await context(workspace)) as BashResult;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to fail");
}

async function ownerOf(workspace: CharacterWorkspace, path: string): Promise<number> {
  return Number((await bash(workspace, `stat -c %u '${path}'`)).stdout.trim());
}

describe.skipIf(!READY)("a character whose tools run as its own user", () => {
  test("runs commands as that user with no capabilities and no way to gain any", async () => {
    const user = await ownUser();
    const result = await bash(await freshWorkspace(), "id -u; id -g; grep -E '^(CapPrm|CapEff|CapAmb|NoNewPrivs):' /proc/self/status");
    expect(result.stdout).toBe(
      `${String(user.uid)}\n${String(user.gid)}\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\n` +
        "CapAmb:\t0000000000000000\nNoNewPrivs:\t1\n",
    );
  });

  test("cannot open, change or signal what belongs to the daemon", async () => {
    const result = await bash(await freshWorkspace(), [
      `cat '${SECRET}'`, `touch '${join(ROOT, "config", "added")}'`, `cat /proc/${String(process.pid)}/environ`,
      `kill -0 ${String(process.pid)}`, `setpriv --reuid=${String(process.getuid?.() ?? 0)} true`, "echo done",
    ].join("; "));
    expect(result.stdout).toBe("done\n");
    expect(result.stderr).toContain(`cat: ${SECRET}: Permission denied`);
    expect(result.stderr).toContain(`touch: cannot touch '${join(ROOT, "config", "added")}': Permission denied`);
    expect(result.stderr).toContain(`cat: /proc/${String(process.pid)}/environ: Permission denied`);
    expect(result.stderr).toContain("Operation not permitted");
    expect(result.stderr).toContain("setpriv: setresuid failed: Operation not permitted");
    expect(readFileSync(SECRET, "utf8")).toBe("isolation-secret\n");
  });

  test("cannot read another character's workspace", async () => {
    const result = await bash(await freshWorkspace(), `ls '${join(ROOT, "workspace", OTHER)}'`);
    expect(result.exit_code).not.toBe(0);
    expect(result.stderr).toContain("Permission denied");
  });

  test("gets its own identity and only the daemon's variables it is given", async () => {
    setTestEnv("SHORE_ISOLATION_SECRET", "daemon only");
    setTestEnv("SHORE_ISOLATION_PASSED", "for the character");
    const user = await ownUser();
    const workspace = await freshWorkspace(["SHORE_ISOLATION_PASSED"]);
    const env = new Map((await bash(workspace, "env")).stdout.trim().split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)] as const;
    }));
    expect(env.get("SHORE_ISOLATION_PASSED")).toBe("for the character");
    expect(env.has("SHORE_ISOLATION_SECRET")).toBe(false);
    expect(env.has("TMPDIR")).toBe(false);
    expect(env.get("HOME")).toBe(user.home);
    expect(env.get("USER")).toBe(USER);
    expect(env.get("PWD")).toBe(workspace.dir);
    expect(env.get("SHORE_WORKSPACE_DIR")).toBe(workspace.dir);
    expect(env.get("PATH")?.startsWith(`${user.home ?? ""}/.local/bin:`)).toBe(true);
  });

  test("reads and edits files with the character's permissions", async () => {
    const user = await ownUser();
    const workspace = await freshWorkspace();
    const ctx = await context(workspace);
    await bash(workspace, `printf 'old text\\n' > note.md; ln -s '${SECRET}' leak.md`);
    expect(String(await dispatchTool("read", { file_path: "note.md" }, ctx))).toContain("1\told text");
    expect(await failure(dispatchTool("read", { file_path: "leak.md" }, ctx))).toContain("EACCES");
    expect(await failure(dispatchTool("read", { file_path: SECRET }, ctx))).toContain("EACCES");
    expect(await failure(dispatchTool("edit", { file_path: SECRET, old_string: "isolation", new_string: "changed" }, ctx))).toContain("EACCES");
    expect(await dispatchTool("edit", { file_path: "note.md", old_string: "old", new_string: "new" }, ctx)).toContain("replaced 1 exact occurrence");
    expect(readFileSync(join(workspace.dir, "note.md"), "utf8")).toBe("new text\n");
    expect(statSync(join(workspace.dir, "note.md")).uid).toBe(user.uid);
    expect(readFileSync(SECRET, "utf8")).toBe("isolation-secret\n");
  });

  test("keeps a prompt file linked to the daemon's secrets out of the prompt, and can still replace it", async () => {
    const workspace = await freshWorkspace();
    const data = join(await privateDir("isolation-prompt"), "ada");
    await bash(workspace, `ln -s '${SECRET}' SOUL.md`);
    expect(await loadPromptFileFromWorkspace(data, workspace, "SOUL.md")).toBeUndefined();
    const replaced = await bash(workspace, "rm SOUL.md && printf 'You are Ada.\\n' > SOUL.md");
    expect(replaced).toMatchObject({ exit_code: 0, prompt_files_changed: ["SOUL.md"] });
    expect(await loadPromptFileFromWorkspace(data, workspace, "SOUL.md")).toBe("You are Ada.\n");
  });

  test.skipIf(!existsSync(PATCH_HELPER))("applies patches as the character", async () => {
    const user = await ownUser();
    const workspace = await freshWorkspace();
    const ctx = await context(workspace);
    const added = await dispatchTool("apply_patch", { patch: "*** Begin Patch\n*** Add File: patched.txt\n+hello\n*** End Patch" }, ctx);
    expect(added).toMatchObject({ exit_code: 0 });
    expect(statSync(join(workspace.dir, "patched.txt")).uid).toBe(user.uid);
    const refused = await dispatchTool("apply_patch", { patch: `*** Begin Patch\n*** Update File: ${SECRET}\n@@\n-isolation-secret\n+changed\n*** End Patch` }, ctx);
    expect(refused).toMatchObject({ exit_code: 1 });
    expect(readFileSync(SECRET, "utf8")).toBe("isolation-secret\n");
  });

  test("a timeout stops the character's command", async () => {
    const workspace = await freshWorkspace();
    const outcome = await failure(dispatchWithinDeadline("bash", { command: "echo $$ > pid; exec sleep 30" }, await context(workspace), 1_000));
    expect(outcome).toBe("timed out after 1s and was cancelled");
    const pid = Number(readFileSync(join(workspace.dir, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("runs the workspace's git as the character, repository settings included", async () => {
    const user = await ownUser();
    const workspace = await freshWorkspace();
    expect(await ensureWorkspaceGitRepo(workspace)).toBe(true);
    await bash(workspace, [
      "git config filter.probe.clean 'sh -c \"id -u > filtered-by; cat\"'", "printf 'a.txt filter=probe\\n' > .gitattributes", "printf x > a.txt",
    ].join("; "));
    expect(await gitCommitAll(workspace, "Ada", "first")).toBe(true);
    expect(await gitHead(workspace)).toMatch(/^[0-9a-f]{40}$/);
    expect(statSync(join(workspace.dir, ".git")).uid).toBe(user.uid);
    expect(readFileSync(join(workspace.dir, "filtered-by"), "utf8").trim()).toBe(String(user.uid));
  });

  test("undoes and redoes a turn's changes as the character, with the history in its home", async () => {
    const user = await ownUser();
    const workspace = await freshWorkspace();
    const turns: WorkspaceTurns = { workspace: workspace.dir, repo: join(await privateDir("isolation-turns"), "unused.git"), character: workspace, name: basename(workspace.dir) };
    const before = await snapshotTree(turns);
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    await bash(workspace, "mkdir -p made && printf turn > made/by-turn.txt");
    await recordTurn(turns, "main", "v1", before);
    expect(await undoTurns(turns, "main", ["v1"])).toEqual({ restored: ["made/by-turn.txt"], skipped: [] });
    expect(existsSync(join(workspace.dir, "made"))).toBe(false);
    expect(await redoTurns(turns, "main", ["v1"])).toEqual({ restored: ["made/by-turn.txt"], skipped: [] });
    expect(statSync(join(workspace.dir, "made", "by-turn.txt")).uid).toBe(user.uid);
    expect(await ownerOf(workspace, join(user.home ?? "", ".cache", "shore", "workspace-turns", `${basename(workspace.dir)}.git`))).toBe(user.uid);
    expect(existsSync(turns.repo)).toBe(false);
  });

  test("restores compaction snapshots as the character", async () => {
    const user = await ownUser();
    const workspace = await freshWorkspace();
    await bash(workspace, "printf before > kept.md");
    const entries = new Map(await workspace.call("snapshot", { root: workspace.dir }));
    await bash(workspace, "rm kept.md");
    await workspace.call("restore", { path: join(workspace.dir, "kept.md"), entry: entries.get("kept.md") ?? null });
    expect(readFileSync(join(workspace.dir, "kept.md"), "utf8")).toBe("before");
    expect(statSync(join(workspace.dir, "kept.md")).uid).toBe(user.uid);
  });

  test("a stdio MCP server can run as a user of its own", async () => {
    const user = await ownUser();
    const launch = await stdioLaunch({ kind: "stdio", command: "id", args: ["-u"], env: {}, user: USER });
    const run = Bun.spawnSync([launch.command, ...launch.args], { env: launch.env, ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }) });
    expect(run.stdout.toString().trim()).toBe(String(user.uid));
  });

  test("exports, imports and deletes the character through its user", async () => {
    const user = await ownUser();
    const root = join(ROOT, "workspace", USER);
    const source = await dirsUnder(root);
    const name = basename((await freshWorkspace([], root)).dir);
    await seedCharacter(source, name);
    const isolated = (dirs: ShoreDirs): ArchiveContext => ({
      dirs, hasCharacter: () => true, withSnapshot: async (run) => await run(), refreshDiscovery: async () => {},
      releaseCharacter: async () => {}, workspace: (character) => new CharacterWorkspace(join(root, character), { user: USER, passEnv: [] }),
    });
    const archive = join(source.runtime, "ada.tar.gz");
    await bash(new CharacterWorkspace(join(root, name), { user: USER, passEnv: [] }), "chmod 600 SOUL.md && mkdir private && printf mine > private/kept.txt");
    expect(await exportCharacter(isolated(source), { character: name, output: archive })).toMatchObject({ character: name });

    const target = await dirsUnder(root);
    const workspace = new CharacterWorkspace(join(root, name), { user: USER, passEnv: [] });
    await deleteCharacter(isolated(source), { character: name, confirm: name });
    expect(await workspace.call("entries", { path: workspace.dir })).toEqual([]);
    await importCharacter({ ...isolated(target), hasCharacter: () => false }, { archive });
    expect(await workspace.call("entries", { path: workspace.dir })).toEqual(["SOUL.md", "private"]);
    expect(await ownerOf(workspace, join(workspace.dir, "private", "kept.txt"))).toBe(user.uid);
    expect((await bash(workspace, "cat SOUL.md private/kept.txt")).stdout).toBe(`You are ${name}.\nmine`);
  });

  test("a browser export over its limits says so, whoever reads the workspace", async () => {
    const root = join(ROOT, "workspace", USER);
    const source = await dirsUnder(root);
    const name = basename((await freshWorkspace([], root)).dir);
    await seedCharacter(source, name);
    await bash(new CharacterWorkspace(join(root, name), { user: USER, passEnv: [] }), "head -c 20000000 /dev/zero > big.bin");
    const archive = join(source.runtime, "limited.tar.gz");
    const ctx: ArchiveContext = {
      dirs: source, limits: { bytes: 50_000, entries: 100 }, hasCharacter: () => true, withSnapshot: async (run) => await run(),
      refreshDiscovery: async () => {}, releaseCharacter: async () => {},
      workspace: (character) => new CharacterWorkspace(join(root, character), { user: USER, passEnv: [] }),
    };
    expect(await failure(exportCharacter(ctx, { character: name, output: archive }))).toBe("Character exceeds browser archive processing limits");
    expect(existsSync(archive)).toBe(false);
  });

  test("an import refuses a workspace the character's user would have to create", async () => {
    const root = join(ROOT, "workspace", USER);
    const source = await dirsUnder(root);
    const name = basename((await freshWorkspace([], root)).dir);
    await seedCharacter(source, name);
    const archive = join(source.runtime, "refused.tar.gz");
    const ctx = (dirs: ShoreDirs, workspaceRoot: string): ArchiveContext => ({
      dirs: { ...dirs, workspace: workspaceRoot }, hasCharacter: () => false, withSnapshot: async (run) => await run(),
      refreshDiscovery: async () => {}, releaseCharacter: async () => {},
      workspace: (character) => new CharacterWorkspace(join(workspaceRoot, character), { user: USER, passEnv: [] }),
    });
    await exportCharacter({ ...ctx(source, root), hasCharacter: () => true }, { character: name, output: archive });
    const target = await dirsUnder(root);
    const elsewhere = (await freshWorkspace([], root)).dir;
    expect(await failure(importCharacter(ctx(target, elsewhere), { archive }))).toContain(`${join(elsewhere, name)} does not exist`);
    expect(await readdir(elsewhere)).toEqual([]);
    expect(existsSync(join(target.config, "characters", name))).toBe(false);
  });
});

describe.skipIf(!READY)("a character without a user of its own", () => {
  test("runs as the daemon's user, without the daemon's capabilities", async () => {
    const workspace = new CharacterWorkspace(await privateDir("isolation-plain"));
    const result = await dispatchTool("bash", { command: "id -u; grep -E '^(CapEff|CapAmb):' /proc/self/status" }, await context(workspace)) as BashResult;
    expect(result.stdout).toBe(`${String(process.getuid?.())}\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n`);
  });
});

async function dirsUnder(workspace: string): Promise<ShoreDirs> {
  const base = await privateDir("isolation-archive");
  const dirs: ShoreDirs = {
    config: join(base, "config"), data: join(base, "data"), cache: join(base, "cache"), runtime: join(base, "runtime"), workspace,
  };
  for (const dir of [dirs.config, dirs.data, dirs.cache, dirs.runtime]) await mkdir(dir, { recursive: true });
  Ledger.create(join(dirs.data, "shore.db")).close();
  return dirs;
}

async function seedCharacter(dirs: ShoreDirs, name: string): Promise<void> {
  const data = join(dirs.data, name);
  await mkdir(join(data, "threads", "main"), { recursive: true });
  await mkdir(join(dirs.config, "characters", name), { recursive: true });
  await writeFile(join(dirs.config, "characters", name, "config.toml"), '[chat]\nmodel = "openai:gpt-test"\n');
  const workspace = new CharacterWorkspace(join(dirs.workspace ?? "", name), { user: USER, passEnv: [] });
  await workspace.call("createFile", { path: join(workspace.dir, "SOUL.md"), data: Buffer.from(`You are ${name}.\n`).toString("base64") });
  const message: Message = {
    msg_id: `m_${name}`, role: "user", content: "hello", content_blocks: [{ type: "text", text: "hello" }], images: [], timestamp: "2026-09-01T00:00:00Z",
  };
  writeDurable(join(data, "threads", "main", "active.jsonl"), `${JSON.stringify(message)}\n`);
  const history = HistoryStore.open(join(dirs.data, "shore.db"));
  history.putSegment(name, 0, { file: "segment-0.jsonl", message_count: 1, compacted_at: "2026-09-01T00:00:00Z" }, [message]);
  history.close();
}
