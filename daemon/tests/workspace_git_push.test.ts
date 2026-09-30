import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";

import {
  ensureWorkspaceGitRepo,
  envWithoutInheritedGitRepo,
  gitCommitAll,
  gitPushWorkspace,
  gitPushWorkspaceBestEffort,
} from "../src/tools/workspace.ts";
import { outcomeOf } from "./support/outcome.ts";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-git-push-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(required(roots.pop()), { recursive: true, force: true });
});

async function gitAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["git", "--version"], { stdout: "ignore", stderr: "ignore" });
  try {
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: envWithoutInheritedGitRepo(),
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: envWithoutInheritedGitRepo(),
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return text.trim();
}

async function gitRevParse(cwd: string, rev: string): Promise<string> {
  return await gitOutput(cwd, "rev-parse", rev);
}

async function gitLogSubjects(cwd: string): Promise<string> {
  return await gitOutput(cwd, "log", "--format=%s");
}

async function workspaceWithRemote(): Promise<{ workspace: string; remote: string }> {
  const root = tempDir();
  const workspace = join(root, "workspace");
  const remote = join(root, "remote.git");

  await git(root, "init", "--bare", "--quiet", remote);
  await ensureWorkspaceGitRepo(workspace);
  writeFileSync(join(workspace, "MEMORY.md"), "# memory\n\n- likes tea\n");
  await gitCommitAll(workspace, "Ada", "memory: compaction");
  await git(workspace, "remote", "add", "origin", remote);
  await git(workspace, "push", "--quiet", "--set-upstream", "origin", "HEAD");

  return { workspace, remote };
}

describe.if(await gitAvailable())("gitPushWorkspace", () => {
  test("a new commit reaches the remote", async () => {
    const { workspace, remote } = await workspaceWithRemote();

    writeFileSync(join(workspace, "MEMORY.md"), "# memory\n\n- likes tea\n- dislikes mornings\n");
    expect(await gitCommitAll(workspace, "Ada", "memory: compaction")).toBe(true);
    expect(await gitPushWorkspace(workspace)).toBe(true);

    const checkout = join(tempDir(), "checkout");
    await git(tempDir(), "clone", "--quiet", remote, checkout);
    expect(readFileSync(join(checkout, "MEMORY.md"), "utf8")).toContain("dislikes mornings");
  });

  test("a repo with no remote is skipped without noise", async () => {
    const workspace = join(tempDir(), "workspace");
    await ensureWorkspaceGitRepo(workspace);
    expect(await gitPushWorkspace(workspace)).toBe(false);
  });

  test("a directory that is not a repo is skipped", async () => {
    expect(await gitPushWorkspace(tempDir())).toBe(false);
  });

  test("an inherited GIT_DIR does not retarget the commit at the surrounding repo", async () => {
    const surrounding = join(tempDir(), "surrounding");
    await git(tempDir(), "init", "--quiet", surrounding);
    await git(
      surrounding,
      "-c",
      "user.name=Surrounding",
      "-c",
      "user.email=surrounding@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "base",
    );
    const before = await gitRevParse(surrounding, "HEAD");

    const workspace = join(tempDir(), "workspace");
    await ensureWorkspaceGitRepo(workspace);
    writeFileSync(join(workspace, "MEMORY.md"), "# memory\n\n- likes tea\n");
    setTestEnv("GIT_DIR", join(surrounding, ".git"));
    try {
      expect(await gitCommitAll(workspace, "Ada", "memory: compaction")).toBe(true);
    } finally {
      restoreTestEnv();
    }

    expect(await gitRevParse(surrounding, "HEAD")).toBe(before);
    expect(await gitLogSubjects(workspace)).toContain("memory: compaction");
  });

  test("the best-effort wrapper swallows a push that fails", async () => {
    const { workspace, remote } = await workspaceWithRemote();
    rmSync(remote, { recursive: true, force: true });

    writeFileSync(join(workspace, "MEMORY.md"), "# memory\n\n- new\n");
    await gitCommitAll(workspace, "Ada", "memory: compaction");

    expect(await outcomeOf(gitPushWorkspace(workspace))).toThrow();
    expect(await gitPushWorkspaceBestEffort(workspace)).toBeUndefined();
  });
});

describe("the compaction push is wired to the push", () => {
  test("run.ts hands `pushAfterCompaction` the push, not a commit", () => {
    const source = readFileSync(
      new URL("../src/memory/compaction/run.ts", import.meta.url),
      "utf8",
    );
    const call = source.slice(source.indexOf("await pushAfterCompaction("));
    const callback = call.slice(0, call.indexOf("});"));

    expect(callback).toContain("gitPushWorkspaceBestEffort");
    expect(callback).not.toContain("gitCommitAll");
  });
});
