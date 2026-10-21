import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Parser } from "tar";
import { deleteCharacter, exportBackup, exportCharacter, importCharacter, readTransfer, writeTransfer, type ArchiveContext } from "../src/commands/archive.ts";
import { ArchiveSpool } from "../src/commands/archive_spool.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { loadConfig } from "../src/config/loader.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { Ledger } from "../src/ledger/store.ts";
import { stdioLaunch } from "../src/mcp/client.ts";
import { loadPromptFileFromWorkspace } from "../src/memory/deferred_edits.ts";
import { writeDurable } from "../src/storage/files.ts";
import type { BashResult } from "../src/tools/bash.ts";
import { canSwitchUser, characterUser, runsWithNoNewPrivs, setprivArgs, type CharacterUser } from "../src/tools/character_user.ts";
import {
  CharacterWorkspace, characterToolsFor, closeWorkspaceHelpers, warnIfNoNewPrivsInherited, type CharacterTools,
} from "../src/tools/character_workspace.ts";
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
const OWN_USER: CharacterTools = { user: USER, passEnv: [], noNewPrivs: true };

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
  const parent = new CharacterWorkspace(root, { ...OWN_USER, passEnv });
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

  test("stays under no_new_privs when it opts out but the daemon runs under it", async () => {
    const workspace = await freshWorkspace();
    const optedOut = new CharacterWorkspace(workspace.dir, { ...workspace.tools, noNewPrivs: false });
    const result = await bash(optedOut, "grep -E '^(CapEff|NoNewPrivs):' /proc/self/status");
    expect(result.stdout).toBe("CapEff:\t0000000000000000\nNoNewPrivs:\t1\n");
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
    expect(env.get("XDG_RUNTIME_DIR")).toBe(`/run/user/${String(user.uid)}`);
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
    expect(launch.env["XDG_RUNTIME_DIR"]).toBe(`/run/user/${String(user.uid)}`);
  });

  test("exports, imports and deletes the character through its user", async () => {
    const user = await ownUser();
    const root = join(ROOT, "workspace", USER);
    const source = await dirsUnder(root);
    const name = basename((await freshWorkspace([], root)).dir);
    await seedCharacter(source, name);
    const isolated = (dirs: ShoreDirs): ArchiveContext => ({
      dirs, characters: () => [], hasCharacter: () => true, withSnapshot: async (run) => await run(), refreshDiscovery: async () => {},
      releaseCharacter: async () => {}, workspace: (character) => new CharacterWorkspace(join(root, character), OWN_USER),
    });
    const archive = join(source.runtime, "ada.tar.gz");
    await bash(new CharacterWorkspace(join(root, name), OWN_USER), "chmod 600 SOUL.md && mkdir private && printf mine > private/kept.txt");
    expect(await exportCharacter(isolated(source), { character: name, output: archive })).toMatchObject({ character: name });

    const target = await dirsUnder(root);
    const workspace = new CharacterWorkspace(join(root, name), OWN_USER);
    await deleteCharacter(isolated(source), { character: name, confirm: name });
    expect(await workspace.call("entries", { path: workspace.dir })).toBeNull();
    await workspace.call("mkdir", { path: workspace.dir });
    await importCharacter({ ...isolated(target), hasCharacter: () => false }, { archive });
    expect(await workspace.call("entries", { path: workspace.dir })).toEqual(["SOUL.md", "private"]);
    expect(await ownerOf(workspace, join(workspace.dir, "private", "kept.txt"))).toBe(user.uid);
    expect((await bash(workspace, "cat SOUL.md private/kept.txt")).stdout).toBe(`You are ${name}.\nmine`);
  });

  test("backs up the character's workspace through its user and later sends only what changed", async () => {
    const root = join(ROOT, "workspace", USER);
    const source = await dirsUnder(root);
    const name = basename((await freshWorkspace([], root)).dir);
    await seedCharacter(source, name);
    const workspace = new CharacterWorkspace(join(root, name), OWN_USER);
    await bash(workspace, "chmod 600 SOUL.md && mkdir private && printf mine > private/kept.txt && chmod 600 private/kept.txt && ln -s SOUL.md soul");
    const ctx: ArchiveContext = {
      dirs: source, characters: () => [name], hasCharacter: () => true, withSnapshot: async (run) => await run(), refreshDiscovery: async () => {},
      releaseCharacter: async () => {}, workspace: (character) => new CharacterWorkspace(join(root, character), OWN_USER),
      spool: new ArchiveSpool(join(source.cache, "archive-transfers"), () => true), owner: 1,
    };
    const first = await tarEntries(ctx, (await exportBackup(ctx)).transfer);
    expect(first.get(`workspace/${name}/private/kept.txt`)?.toString()).toBe("mine");
    expect(first.get(`workspace/${name}/soul`)?.toString()).toBe("-> SOUL.md");
    await bash(workspace, "printf again >> private/kept.txt");
    const manifest = first.get("manifest.json") ?? Buffer.alloc(0);
    const base = (await writeTransfer(ctx, { data: manifest.toString("base64") })).transfer;
    const second = await exportBackup(ctx, { base });
    const delta = await tarEntries(ctx, second.transfer);
    expect([...delta.keys()].filter((path) => path.startsWith("workspace/"))).toEqual([`workspace/${name}/private/kept.txt`]);
    expect(delta.get(`workspace/${name}/private/kept.txt`)?.toString()).toBe("mineagain");
    expect(second).toMatchObject({ files_sent: 1 });
  });

  test("a browser export over its limits says so, whoever reads the workspace", async () => {
    const root = join(ROOT, "workspace", USER);
    const source = await dirsUnder(root);
    const name = basename((await freshWorkspace([], root)).dir);
    await seedCharacter(source, name);
    await bash(new CharacterWorkspace(join(root, name), OWN_USER), "head -c 20000000 /dev/zero > big.bin");
    const archive = join(source.runtime, "limited.tar.gz");
    const ctx: ArchiveContext = {
      dirs: source, limits: { bytes: 50_000, entries: 100 }, characters: () => [], hasCharacter: () => true, withSnapshot: async (run) => await run(),
      refreshDiscovery: async () => {}, releaseCharacter: async () => {},
      workspace: (character) => new CharacterWorkspace(join(root, character), OWN_USER),
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
      dirs: { ...dirs, workspace: workspaceRoot }, characters: () => [], hasCharacter: () => false, withSnapshot: async (run) => await run(),
      refreshDiscovery: async () => {}, releaseCharacter: async () => {},
      workspace: (character) => new CharacterWorkspace(join(workspaceRoot, character), OWN_USER),
    });
    await exportCharacter({ ...ctx(source, root), hasCharacter: () => true }, { character: name, output: archive });
    const target = await dirsUnder(root);
    const elsewhere = (await freshWorkspace([], root)).dir;
    expect(await failure(importCharacter(ctx(target, elsewhere), { archive }))).toContain(`${join(elsewhere, name)} does not exist`);
    expect(await readdir(elsewhere)).toEqual([]);
    expect(existsSync(join(target.config, "characters", name))).toBe(false);
  });

  test("a daemon whose character has a workspace helper running stops when told to", async () => {
    const { daemon, logged, log } = await startDaemonProcess();
    try {
      for (const deadline = Date.now() + 30_000; !catchesSigterm(daemon.pid); await Bun.sleep(20)) {
        if (Date.now() > deadline || daemon.exitCode !== null) throw new Error(`the daemon did not start:\n${log()}`);
      }
      const helpers = childrenOf(daemon.pid).filter((pid) => commandOf(pid).includes("--workspace-helper"));
      expect(helpers).toHaveLength(1);

      daemon.kill("SIGTERM");
      const code = await Promise.race([daemon.exited, Bun.sleep(8_000).then(() => "still running")]);
      await Promise.race([logged, Bun.sleep(1_000)]);

      expect(code, log()).toBe(0);
      expect(log()).toContain("Daemon shut down cleanly");
      expect(log()).not.toContain("exiting anyway");
      expect(helpers.filter(running)).toEqual([]);
    } finally {
      daemon.kill("SIGKILL");
    }
  }, 60_000);

  test("runs the character's ~/.init.sh as that user when the daemon starts, and what it starts outlives it", async () => {
    const user = await ownUser();
    const home = new CharacterWorkspace(user.home ?? "", OWN_USER);
    const script = join(home.dir, ".init.sh");
    const output = join(home.dir, ".init.log");
    const commands = [
      "id -u",
      "grep -E '^(CapEff|CapAmb|NoNewPrivs):' /proc/self/status",
      "env | grep -E '^(HOME|USER|SHORE_TOKEN|SHORE_ISOLATION_ROOT)=' | sort",
      "sleep 300 &",
      "echo \"$$ $!\"",
    ];
    await home.call("writeFile", { path: script, data: Buffer.from(`${commands.join("\n")}\n`).toString("base64") });
    const { daemon, logged, log } = await startDaemonProcess({ SHORE_TOKEN: "isolation-token" });
    let pids: RegExpExecArray | null = null;
    try {
      let text = "";
      for (const deadline = Date.now() + 30_000; pids === null; await Bun.sleep(20)) {
        if (Date.now() > deadline || daemon.exitCode !== null) throw new Error(`the init script did not run:\n${log()}\n${text}`);
        const [read] = await home.call("readFiles", { paths: [output] });
        text = read !== undefined && "data" in read ? Buffer.from(read.data, "base64").toString("utf8") : "";
        pids = /^(\d+) (\d+)\n$/m.exec(text);
      }
      const [, scriptPid = "", servicePid = ""] = pids;
      expect(text.slice(0, pids.index)).toBe(
        `${String(user.uid)}\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\nHOME=${user.home ?? ""}\nUSER=${USER}\n`,
      );
      for (const deadline = Date.now() + 5_000; running(Number(scriptPid)); await Bun.sleep(20)) {
        if (Date.now() > deadline) throw new Error("the init script did not exit");
      }
      expect(running(Number(servicePid))).toBe(true);
      expect(procFile(Number(servicePid), "status")).toMatch(new RegExp(`^Uid:\\s+${String(user.uid)}\\s`, "m"));

      daemon.kill("SIGTERM");
      const code = await Promise.race([daemon.exited, Bun.sleep(8_000).then(() => "still running")]);
      await Promise.race([logged, Bun.sleep(1_000)]);
      expect(code, log()).toBe(0);
    } finally {
      daemon.kill("SIGKILL");
      if (pids?.[2] !== undefined && running(Number(pids[2]))) process.kill(Number(pids[2]), "SIGKILL");
      await home.call("deleteFile", { path: script });
      await home.call("deleteFile", { path: output }).catch(() => {});
    }
  }, 60_000);
});

describe("tools.no_new_privs", () => {
  const own = (uid: number): CharacterUser => ({ spec: String(uid), uid, gid: uid, name: undefined, home: undefined, shell: undefined });

  test("is on unless a character's own config turns it off", async () => {
    const root = await privateDir("no-new-privs");
    const characters = { ada: 'user = "ada"\nno_new_privs = false', bea: 'user = "bea"', cy: 'user = "cy"\nno_new_privs = "false"' };
    for (const [name, tools] of Object.entries(characters)) {
      await mkdir(join(root, "characters", name), { recursive: true });
      await writeFile(join(root, "characters", name, "config.toml"), `[tools]\n${tools}\n`);
    }
    await writeFile(join(root, "config.toml"), "");
    const config = loadConfig(join(root, "config.toml"), {
      env: { SHORE_CONFIG_DIR: root, SHORE_DATA_DIR: join(root, "data"), SHORE_CACHE_DIR: join(root, "cache") },
      onWarn: () => {},
    });
    expect(config.app.tools.no_new_privs).toBe(true);
    expect(characterToolsFor(config, "ada")).toEqual({ user: "ada", passEnv: [], noNewPrivs: false });
    expect(characterToolsFor(config, "bea")).toEqual({ user: "bea", passEnv: [], noNewPrivs: true });
    expect(() => characterToolsFor(config, "cy")).toThrow("a boolean");
  });

  test("turned off drops only setpriv's --no-new-privs, and only for a user of the character's own", () => {
    const caps = ["--inh-caps=-all", "--ambient-caps=-all"];
    expect(setprivArgs(own(4001))).toEqual(["--reuid=4001", "--regid=4001", "--clear-groups", "--no-new-privs", ...caps]);
    expect(setprivArgs(own(4001), false)).toEqual(["--reuid=4001", "--regid=4001", "--clear-groups", ...caps]);
    expect(setprivArgs(undefined, false)).toEqual(caps);
  });

  test("is read from the daemon's own status", () => {
    expect(runsWithNoNewPrivs("Name:\tbun\nNoNewPrivs:\t1\nSeccomp:\t0\n")).toBe(true);
    expect(runsWithNoNewPrivs("Name:\tbun\nNoNewPrivs:\t0\nSeccomp:\t0\n")).toBe(false);
    expect(runsWithNoNewPrivs("Name:\tbun\n")).toBe(false);
  });

  test("turned off under a daemon that runs with it warns once per user", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const optedOut = { ...OWN_USER, noNewPrivs: false };
      warnIfNoNewPrivsInherited(OWN_USER, own(4002), "NoNewPrivs:\t1\n");
      warnIfNoNewPrivsInherited(optedOut, own(4002), "NoNewPrivs:\t0\n");
      expect(warn).not.toHaveBeenCalled();
      warnIfNoNewPrivsInherited(optedOut, own(4002), "NoNewPrivs:\t1\n");
      warnIfNoNewPrivsInherited(optedOut, own(4002), "NoNewPrivs:\t1\n");
      expect(warn).toHaveBeenCalledTimes(1);
      warnIfNoNewPrivsInherited(optedOut, own(4003), "NoNewPrivs:\t1\n");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe.skipIf(!READY)("a character without a user of its own", () => {
  test("runs as the daemon's user, without the daemon's capabilities", async () => {
    const workspace = new CharacterWorkspace(await privateDir("isolation-plain"));
    const result = await dispatchTool("bash", { command: "id -u; grep -E '^(CapEff|CapAmb):' /proc/self/status" }, await context(workspace)) as BashResult;
    expect(result.stdout).toBe(`${String(process.getuid?.())}\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n`);
  });
});

async function startDaemonProcess(env: Record<string, string> = {}) {
  const root = (await freshWorkspace()).dir;
  const character = new CharacterWorkspace(join(root, "ada"), OWN_USER);
  await character.call("mkdir", { path: character.dir });
  await character.call("createFile", { path: join(character.dir, "SOUL.md"), data: Buffer.from("You are Ada.\n").toString("base64") });
  const base = await privateDir("isolation-daemon");
  await mkdir(join(base, "config"));
  await writeFile(join(base, "config", "config.toml"), `[tools]\nuser = ${JSON.stringify(USER)}\n`);
  const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "daemon", "main.ts")], {
    env: {
      ...process.env, SHORE_CONFIG_DIR: join(base, "config"), SHORE_DATA_DIR: join(base, "data"), SHORE_CACHE_DIR: join(base, "cache"),
      SHORE_RUNTIME_DIR: join(base, "runtime"), SHORE_WORKSPACE_DIR: root, SHORE_ADDR: "127.0.0.1:0", SHORE_WEB_ADDR: "127.0.0.1:0", ...env,
    },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  let log = "";
  const decoder = new TextDecoder();
  const logged = (async () => {
    for await (const chunk of daemon.stderr) log += decoder.decode(chunk, { stream: true });
  })();
  return { daemon, logged, log: () => log };
}

async function tarEntries(ctx: ArchiveContext, transfer: string): Promise<Map<string, Buffer>> {
  const parts: Buffer[] = [];
  for (let offset = 0, total = 1; offset < total;) {
    const chunk = await readTransfer(ctx, { transfer, offset });
    const bytes = Buffer.from(chunk.data, "base64");
    parts.push(bytes); offset += bytes.length; total = chunk.bytes;
  }
  const entries = new Map<string, Buffer>();
  const pending: Promise<void>[] = [];
  const parser = new Parser({
    onReadEntry: (entry) => {
      if (entry.type === "SymbolicLink") entries.set(entry.path, Buffer.from(`-> ${entry.linkpath ?? ""}`));
      if (entry.type !== "File") { entry.resume(); return; }
      pending.push(entry.concat().then((data) => { entries.set(entry.path, Buffer.from(data)); }));
    },
  });
  parser.end(Buffer.concat(parts));
  await Promise.all(pending);
  return entries;
}

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
  const workspace = new CharacterWorkspace(join(dirs.workspace ?? "", name), OWN_USER);
  await workspace.call("createFile", { path: join(workspace.dir, "SOUL.md"), data: Buffer.from(`You are ${name}.\n`).toString("base64") });
  const message: Message = {
    msg_id: `m_${name}`, role: "user", content: "hello", content_blocks: [{ type: "text", text: "hello" }], images: [], timestamp: "2026-09-01T00:00:00Z",
  };
  writeDurable(join(data, "threads", "main", "active.jsonl"), `${JSON.stringify(message)}\n`);
  const history = HistoryStore.open(join(dirs.data, "shore.db"));
  history.putSegment(name, 0, { file: "segment-0.jsonl", message_count: 1, compacted_at: "2026-09-01T00:00:00Z" }, [message]);
  history.close();
}

function procFile(pid: number, file: string): string {
  try {
    return readFileSync(`/proc/${String(pid)}/${file}`, "utf8");
  } catch {
    return "";
  }
}

function procState(pid: number): { state: string; parent: number } {
  const [state = "", parent = "0"] = procFile(pid, "stat").replace(/^.*\) /s, "").split(" ");
  return { state, parent: Number(parent) };
}

function childrenOf(parent: number): number[] {
  return readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number).filter((pid) => procState(pid).parent === parent);
}

function commandOf(pid: number): string {
  return procFile(pid, "cmdline").split("\0").join(" ");
}

function catchesSigterm(pid: number): boolean {
  const caught = /^SigCgt:\s*([0-9a-f]+)$/m.exec(procFile(pid, "status"))?.[1];
  return caught !== undefined && (BigInt(`0x${caught}`) >> 14n & 1n) === 1n;
}

function running(pid: number): boolean {
  return !["", "Z", "X"].includes(procState(pid).state);
}
