/**
 * The post-compaction workspace push, and the wiring that fires it.
 *
 * `gitPushWorkspaceBestEffort` ported across and then had no caller: the
 * compaction path's push slot in `memory/compaction/run.ts` was filled with
 * `gitCommitAll` instead, so `[memory] git_push = true` made a redundant commit
 * and never pushed. The Rust calls `git_push_workspace_best_effort` there
 * (`memory/compaction/mod.rs:956`); the pass's own writes are already committed
 * through the workspace `git` tool as they are made.
 *
 * `pushAfterCompaction` takes the push as a callback, so `compaction_parity`
 * pins the *gate* — enabled, and a `compacted` outcome — while injecting a stub
 * for the effect. That is what hid the wrong function at the only real call
 * site, and it is why the last case here asserts on reachability rather than on
 * behaviour. Same shape as `DEFAULT_CONFIG_TOML` in `default_config.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureWorkspaceGitRepo,
  gitCommitAll,
  gitPushWorkspace,
  gitPushWorkspaceBestEffort,
} from "../src/tools/workspace.ts";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-git-push-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * Whether a `git` binary is on PATH.
 *
 * The git-history feature is best-effort without git, so these skip cleanly on
 * a minimal host rather than failing — the Rust's `git_available()`.
 */
async function gitAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["git", "--version"], { stdout: "ignore", stderr: "ignore" });
  try {
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

/** A workspace repo with one commit, wired to a bare remote it can push to. */
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

    // Read it back out of the bare remote rather than trusting the exit code.
    const checkout = join(tempDir(), "checkout");
    await git(tempDir(), "clone", "--quiet", remote, checkout);
    expect(readFileSync(join(checkout, "MEMORY.md"), "utf8")).toContain("dislikes mornings");
  });

  test("a repo with no remote is skipped without noise", async () => {
    // A freshly bootstrapped workspace has none until the operator adds one.
    // The daemon never invents a remote, so this is the common case, not a
    // failure.
    const workspace = join(tempDir(), "workspace");
    await ensureWorkspaceGitRepo(workspace);
    expect(await gitPushWorkspace(workspace)).toBe(false);
  });

  test("a directory that is not a repo is skipped", async () => {
    expect(await gitPushWorkspace(tempDir())).toBe(false);
  });

  test("the best-effort wrapper swallows a push that fails", async () => {
    // The pass already archived; a remote that rejects must not undo it.
    const { workspace, remote } = await workspaceWithRemote();
    rmSync(remote, { recursive: true, force: true });

    writeFileSync(join(workspace, "MEMORY.md"), "# memory\n\n- new\n");
    await gitCommitAll(workspace, "Ada", "memory: compaction");

    await expect(gitPushWorkspace(workspace)).rejects.toThrow();
    expect(await gitPushWorkspaceBestEffort(workspace)).toBeUndefined();
  });
});

describe("the compaction push is wired to the push", () => {
  test("run.ts hands `pushAfterCompaction` the push, not a commit", () => {
    // The regression this file exists for, and the only assertion that could
    // have caught it: `pushAfterCompaction`'s callback is injected, so no
    // behavioural test of it can see which function the daemon actually passes.
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
