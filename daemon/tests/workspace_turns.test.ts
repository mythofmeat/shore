import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message } from "../src/engine/types.ts";
import {
  aliasTurn,
  pruneTurns,
  recordedTurns,
  recordTurn,
  redoTurns,
  replyVersions,
  snapshotTree,
  undoTurns,
  workspaceTurnsFor,
  type WorkspaceTurns,
} from "../src/tools/workspace_turns.ts";
import { ensureWorkspaceGitRepo, gitCommitAll, gitHead } from "../src/tools/workspace.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(required(roots.pop()), { recursive: true, force: true });
});

function setup(): WorkspaceTurns {
  const root = mkdtempSync(join(tmpdir(), "shore-turns-"));
  roots.push(root);
  const turns = workspaceTurnsFor({ config: join(root, "config"), cache: join(root, "cache"), workspace: join(root, "workspace") }, "Ada");
  mkdirSync(turns.workspace, { recursive: true });
  return turns;
}

const file = (turns: WorkspaceTurns, path: string): string => join(turns.workspace, path);
const read = (turns: WorkspaceTurns, path: string): string => readFileSync(file(turns, path), "utf8");
const write = (turns: WorkspaceTurns, path: string, text: string): void => {
  mkdirSync(join(file(turns, path), ".."), { recursive: true });
  writeFileSync(file(turns, path), text);
};

async function turn(turns: WorkspaceTurns, version: string, change: () => void, thread = "main"): Promise<void> {
  const before = await snapshotTree(turns);
  change();
  await recordTurn(turns, thread, version, before);
}

function reply(version: string, alternatives: string[] = []): Message {
  return {
    msg_id: `m_${version}`,
    role: "assistant",
    content: "hi",
    images: [],
    content_blocks: [{ type: "text", text: "hi" }],
    timestamp: "2026-10-08T00:00:00Z",
    version,
    ...(alternatives.length === 0 ? {} : { alternatives: alternatives.map((alt) => ({ content: "", images: [], content_blocks: [], timestamp: "", version: alt })) }),
  };
}

describe("workspace turns", () => {
  test("undo puts back created, modified, and deleted files, and redo replays them", async () => {
    const turns = setup();
    write(turns, "MEMORY.md", "old memory\n");
    write(turns, "gone.txt", "bye\n");
    await turn(turns, "mv_1", () => {
      write(turns, "MEMORY.md", "new memory\n");
      write(turns, "notes/deep/today.md", "fresh\n");
      rmSync(file(turns, "gone.txt"));
    });

    const undone = await undoTurns(turns, "main", ["mv_1"]);
    expect(undone.skipped).toEqual([]);
    expect(undone.restored.sort()).toEqual(["MEMORY.md", "gone.txt", "notes/deep/today.md"]);
    expect(read(turns, "MEMORY.md")).toBe("old memory\n");
    expect(read(turns, "gone.txt")).toBe("bye\n");
    expect(existsSync(file(turns, "notes"))).toBe(false);

    await redoTurns(turns, "main", ["mv_1"]);
    expect(read(turns, "MEMORY.md")).toBe("new memory\n");
    expect(read(turns, "notes/deep/today.md")).toBe("fresh\n");
    expect(existsSync(file(turns, "gone.txt"))).toBe(false);
  });

  test("undo restores modes and symlinks", async () => {
    const turns = setup();
    write(turns, "run.sh", "echo hi\n");
    chmodSync(file(turns, "run.sh"), 0o755);
    symlinkSync("run.sh", file(turns, "link"));
    await turn(turns, "mv_1", () => {
      chmodSync(file(turns, "run.sh"), 0o644);
      rmSync(file(turns, "link"));
      write(turns, "link", "plain\n");
    });

    await undoTurns(turns, "main", ["mv_1"]);
    expect(lstatSync(file(turns, "run.sh")).mode & 0o111).not.toBe(0);
    expect(lstatSync(file(turns, "link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(file(turns, "link"))).toBe("run.sh");
  });

  test("files changed after the turn are skipped, not overwritten", async () => {
    const turns = setup();
    write(turns, "a.md", "a0\n");
    write(turns, "b.md", "b0\n");
    await turn(turns, "mv_1", () => {
      write(turns, "a.md", "a1\n");
      write(turns, "b.md", "b1\n");
    });
    write(turns, "b.md", "b2 by the user\n");

    const undone = await undoTurns(turns, "main", ["mv_1"]);
    expect(undone).toEqual({ restored: ["a.md"], skipped: ["b.md"] });
    expect(read(turns, "a.md")).toBe("a0\n");
    expect(read(turns, "b.md")).toBe("b2 by the user\n");
  });

  test("undoing several turns newest first walks back to before the oldest", async () => {
    const turns = setup();
    write(turns, "log.md", "0\n");
    await turn(turns, "mv_1", () => write(turns, "log.md", "1\n"));
    await turn(turns, "mv_2", () => write(turns, "log.md", "2\n"));

    await undoTurns(turns, "main", ["mv_2", "mv_1"]);
    expect(read(turns, "log.md")).toBe("0\n");
  });

  test("turns without changes or without records are no-ops", async () => {
    const turns = setup();
    write(turns, "same.md", "x\n");
    await turn(turns, "mv_1", () => undefined);
    expect(await recordedTurns(turns, "main", ["mv_1", "mv_missing"])).toEqual([]);
    expect(await undoTurns(turns, "main", ["mv_1", "mv_missing"])).toEqual({ restored: [], skipped: [] });
    expect(read(turns, "same.md")).toBe("x\n");
  });

  test("threads keep separate records", async () => {
    const turns = setup();
    await turn(turns, "mv_1", () => write(turns, "side.md", "side\n"), "side thread");
    expect(await recordedTurns(turns, "main", ["mv_1"])).toEqual([]);
    expect(await recordedTurns(turns, "side thread", ["mv_1"])).toEqual(["mv_1"]);
  });

  test("an alias survives a reply edit", async () => {
    const turns = setup();
    await turn(turns, "mv_1", () => write(turns, "x.md", "x\n"));
    await aliasTurn(turns, "main", "mv_1", "mv_edited");
    await undoTurns(turns, "main", ["mv_edited"]);
    expect(existsSync(file(turns, "x.md"))).toBe(false);
  });

  test("prune drops records for replies no longer in the conversation", async () => {
    const turns = setup();
    await turn(turns, "mv_1", () => write(turns, "1.md", "1\n"));
    await turn(turns, "mv_2", () => write(turns, "2.md", "2\n"));
    await turn(turns, "mv_3", () => write(turns, "3.md", "3\n"));

    await pruneTurns(turns, "main", [reply("mv_3", ["mv_1"])]);
    expect(await recordedTurns(turns, "main", ["mv_1", "mv_2", "mv_3"])).toEqual(["mv_1", "mv_3"]);
  });

  test("the character's own git repo is left alone", async () => {
    const turns = setup();
    await ensureWorkspaceGitRepo(turns.workspace);
    write(turns, "SOUL.md", "soul\n");
    await gitCommitAll(turns.workspace, "Ada", "start");
    const head = await gitHead(turns.workspace);

    await turn(turns, "mv_1", () => write(turns, "SOUL.md", "changed\n"));
    await undoTurns(turns, "main", ["mv_1"]);
    expect(read(turns, "SOUL.md")).toBe("soul\n");
    expect(await gitHead(turns.workspace)).toBe(head);
    expect(await gitCommitAll(turns.workspace, "Ada", "noop")).toBe(false);
    expect(existsSync(join(turns.workspace, ".git", "refs", "turns"))).toBe(false);
  });

  test("a missing workspace records nothing", async () => {
    const turns = setup();
    rmSync(turns.workspace, { recursive: true });
    expect(await snapshotTree(turns)).toBeUndefined();
    expect(await undoTurns(turns, "main", ["mv_1"])).toEqual({ restored: [], skipped: [] });
  });

  test("reply versions follow merged tool loops", () => {
    const toolUse: Message = { ...reply("mv_a"), content_blocks: [{ type: "tool_use", id: "t1", name: "read", input: {} }] };
    const toolResult: Message = { msg_id: "m_r", role: "user", content: "", images: [], content_blocks: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], timestamp: "", version: "mv_r" };
    expect(replyVersions([toolUse, toolResult, reply("mv_b")])).toEqual(["mv_b"]);
  });
});
