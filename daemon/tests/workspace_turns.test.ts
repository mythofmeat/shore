import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message } from "../src/engine/types.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import {
  aliasTurn,
  pruneTurns,
  recordedTurns,
  redoTurns,
  replyVersions,
  undoTurns,
  withWriteWindow,
  WorkspaceRecorder,
  workspaceTurnsFor,
  type WorkspaceTurns,
} from "../src/tools/workspace_turns.ts";
import { ensureWorkspaceGitRepo, gitCommitAll, gitHead } from "../src/tools/workspace.ts";

function setup(): WorkspaceTurns {
  const root = mkdtempSync(join(tmpdir(), "shore-turns-"));
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

const gitIn = (turns: WorkspaceTurns, ...args: string[]): string =>
  execFileSync("git", args, { cwd: turns.workspace, encoding: "utf8" }).trim();

const commit = (turns: WorkspaceTurns, message: string): void => {
  gitIn(turns, "-c", "user.name=Ada", "-c", "user.email=ada@shore.local", "commit", "--quiet", "-m", message);
};

async function startedRepo(): Promise<{ turns: WorkspaceTurns; start: string | undefined }> {
  const turns = setup();
  await ensureWorkspaceGitRepo(turns.workspace);
  write(turns, "SOUL.md", "soul\n");
  await gitCommitAll(turns.workspace, "Ada", "start");
  return { turns, start: await gitHead(turns.workspace) };
}

async function turn(turns: WorkspaceTurns, version: string, change: () => void, thread = "main"): Promise<void> {
  const recorder = new WorkspaceRecorder(turns);
  await recorder.track(async () => change());
  await recorder.settle(thread, version);
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

  test("undoing a turn that committed moves HEAD back, and redo moves it forward", async () => {
    const turns = setup();
    await ensureWorkspaceGitRepo(turns.workspace);
    write(turns, "SOUL.md", "soul\n");
    await gitCommitAll(turns.workspace, "Ada", "start");
    const start = await gitHead(turns.workspace);

    await turn(turns, "mv_1", () => {
      write(turns, "notes/today.md", "note\n");
      gitIn(turns, "add", "-A");
      gitIn(turns, "-c", "user.name=Ada", "-c", "user.email=ada@shore.local", "commit", "--quiet", "-m", "today's note");
    });
    const committed = await gitHead(turns.workspace);

    await undoTurns(turns, "main", ["mv_1"]);
    expect(existsSync(file(turns, "notes"))).toBe(false);
    expect(await gitHead(turns.workspace)).toBe(start);
    expect(gitIn(turns, "status", "--porcelain")).toBe("");

    await redoTurns(turns, "main", ["mv_1"]);
    expect(read(turns, "notes/today.md")).toBe("note\n");
    expect(await gitHead(turns.workspace)).toBe(committed);
    expect(gitIn(turns, "status", "--porcelain")).toBe("");
  });

  test("undoing a pushed commit reverts it instead of rewriting history", async () => {
    const turns = setup();
    const remote = `${turns.workspace}-remote.git`;
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    await ensureWorkspaceGitRepo(turns.workspace);
    write(turns, "SOUL.md", "soul\n");
    await gitCommitAll(turns.workspace, "Ada", "start");
    gitIn(turns, "remote", "add", "origin", remote);
    gitIn(turns, "push", "--quiet", "--set-upstream", "origin", "HEAD");

    await turn(turns, "mv_1", () => {
      write(turns, "SOUL.md", "changed\n");
      gitIn(turns, "-c", "user.name=Ada", "-c", "user.email=ada@shore.local", "commit", "--quiet", "-am", "new soul");
      gitIn(turns, "push", "--quiet");
    });
    const pushed = await gitHead(turns.workspace);

    await undoTurns(turns, "main", ["mv_1"]);
    expect(read(turns, "SOUL.md")).toBe("soul\n");
    expect(gitIn(turns, "log", "-1", "--format=%P %s")).toBe(`${pushed} Revert "new soul"`);
    expect(gitIn(turns, "status", "--porcelain")).toBe("");

    await redoTurns(turns, "main", ["mv_1"]);
    expect(read(turns, "SOUL.md")).toBe("changed\n");
    expect(await gitHead(turns.workspace)).toBe(pushed);
    expect(gitIn(turns, "status", "--porcelain")).toBe("");
  });

  test("commits made after the turn keep HEAD where it is", async () => {
    const turns = setup();
    await ensureWorkspaceGitRepo(turns.workspace);
    write(turns, "SOUL.md", "soul\n");
    await gitCommitAll(turns.workspace, "Ada", "start");
    await turn(turns, "mv_1", () => {
      write(turns, "a.md", "a\n");
      gitIn(turns, "add", "-A");
      gitIn(turns, "-c", "user.name=Ada", "-c", "user.email=ada@shore.local", "commit", "--quiet", "-m", "a");
    });
    write(turns, "b.md", "b\n");
    await gitCommitAll(turns.workspace, "Ada", "later");
    const later = await gitHead(turns.workspace);

    await undoTurns(turns, "main", ["mv_1"]);
    expect(await gitHead(turns.workspace)).toBe(later);
  });

  test("a missing workspace records nothing", async () => {
    const turns = setup();
    rmSync(turns.workspace, { recursive: true });
    await turn(turns, "mv_1", () => undefined);
    expect(await recordedTurns(turns, "main", ["mv_1"])).toEqual([]);
    expect(await undoTurns(turns, "main", ["mv_1"])).toEqual({ restored: [], skipped: [] });
  });

  test("undoing a reply leaves files another reply changed while its tool call ran", async () => {
    const turns = setup();
    write(turns, "a.md", "a0\n");
    write(turns, "b.md", "b0\n");
    const first = new WorkspaceRecorder(turns);
    const second = new WorkspaceRecorder(turns);
    await first.track(async () => {
      write(turns, "a.md", "a1\n");
      await second.track(async () => write(turns, "b.md", "b1 from the other thread\n"));
    });
    await first.settle("main", "mv_1");
    await second.settle("side", "mv_2");

    const undone = await undoTurns(turns, "main", ["mv_1"]);
    expect(undone).toEqual({ restored: ["a.md"], skipped: ["b.md"] });
    expect(read(turns, "a.md")).toBe("a0\n");
    expect(read(turns, "b.md")).toBe("b1 from the other thread\n");
  });

  test("undoing a reply keeps a compaction commit made while its tool call ran", async () => {
    const turns = setup();
    await ensureWorkspaceGitRepo(turns.workspace);
    write(turns, "SOUL.md", "soul\n");
    await gitCommitAll(turns.workspace, "Ada", "start");
    const recorder = new WorkspaceRecorder(turns);
    await recorder.track(async () => {
      write(turns, "a.md", "a\n");
      await withWriteWindow(turns, {}, async () => {
        write(turns, "memory/fact.md", "remembered\n");
        gitIn(turns, "add", "memory");
        gitIn(turns, "-c", "user.name=Ada", "-c", "user.email=ada@shore.local", "commit", "--quiet", "-m", "memory");
        return { value: undefined, paths: ["memory/fact.md"], head: true };
      });
    });
    await recorder.settle("main", "mv_1");
    const compacted = await gitHead(turns.workspace);

    await undoTurns(turns, "main", ["mv_1"]);
    expect(existsSync(file(turns, "a.md"))).toBe(false);
    expect(read(turns, "memory/fact.md")).toBe("remembered\n");
    expect(await gitHead(turns.workspace)).toBe(compacted);
  });

  test("undoing a reply leaves a file written by another reply whose tool call outlasted its own", async () => {
    const turns = setup();
    write(turns, "a.md", "a0\n");
    write(turns, "b.md", "b0\n");
    const first = new WorkspaceRecorder(turns);
    const second = new WorkspaceRecorder(turns);
    const wrote = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let other: Promise<void> = Promise.resolve();
    await first.track(async () => {
      other = second.track(async () => {
        write(turns, "b.md", "b1 from the other thread\n");
        wrote.resolve();
        await finish.promise;
      });
      await wrote.promise;
      write(turns, "a.md", "a1\n");
    });
    finish.resolve();
    await other;
    await first.settle("main", "mv_1");
    await second.settle("side", "mv_2");

    expect((await undoTurns(turns, "main", ["mv_1"])).skipped).toContain("b.md");
    expect(read(turns, "b.md")).toBe("b1 from the other thread\n");
  });

  test("undoing a reply keeps a commit another reply made while its tool call ran", async () => {
    const { turns } = await startedRepo();
    const first = new WorkspaceRecorder(turns);
    const second = new WorkspaceRecorder(turns);
    await first.track(async () => {
      write(turns, "a.md", "a\n");
      await second.track(async () => {
        write(turns, "b.md", "b\n");
        gitIn(turns, "add", "b.md");
        commit(turns, "b");
      });
    });
    await first.settle("main", "mv_1");
    await second.settle("side", "mv_2");
    const committed = await gitHead(turns.workspace);

    await undoTurns(turns, "main", ["mv_1"]);
    expect(existsSync(file(turns, "a.md"))).toBe(false);
    expect(read(turns, "b.md")).toBe("b\n");
    expect(await gitHead(turns.workspace)).toBe(committed);
  });

  test("an alias of a reply with several tool calls undoes all of them", async () => {
    const turns = setup();
    const recorder = new WorkspaceRecorder(turns);
    await recorder.track(async () => write(turns, "x.md", "x\n"));
    await recorder.track(async () => write(turns, "y.md", "y\n"));
    await recorder.settle("main", "mv_1");
    await aliasTurn(turns, "main", "mv_1", "mv_edited");

    await undoTurns(turns, "main", ["mv_edited"]);
    expect(existsSync(file(turns, "x.md"))).toBe(false);
    expect(existsSync(file(turns, "y.md"))).toBe(false);
  });

  test("undoing a reply whose dozen tool calls each rewrote one file puts back the original, and redo the last", async () => {
    const turns = setup();
    write(turns, "log.md", "0\n");
    const recorder = new WorkspaceRecorder(turns);
    for (let call = 1; call <= 12; call += 1) {
      await recorder.track(async () => write(turns, "log.md", `${String(call)}\n`));
    }
    await recorder.settle("main", "mv_1");

    await undoTurns(turns, "main", ["mv_1"]);
    expect(read(turns, "log.md")).toBe("0\n");
    await redoTurns(turns, "main", ["mv_1"]);
    expect(read(turns, "log.md")).toBe("12\n");
  });

  test("undoing a reply puts back the original when its next tool call starts the moment the last one returns", async () => {
    const turns = setup();
    write(turns, "log.md", "0\n");
    const recorder = new WorkspaceRecorder(turns);
    const secondStarted = Promise.withResolvers<void>();
    let hold: Promise<unknown> | undefined;
    const call = CharacterWorkspace.prototype.call.bind(new CharacterWorkspace(turns.workspace));
    const spy = spyOn(CharacterWorkspace.prototype, "call").mockImplementation((op, args, signal) => {
      const held = hold;
      hold = undefined;
      return Promise.resolve(held).then(() => call(op, args, signal));
    });
    try {
      await recorder.track(async () => {
        write(turns, "log.md", "1\n");
        hold = Promise.race([secondStarted.promise, Bun.sleep(100)]);
      });
      await recorder.track(async () => {
        secondStarted.resolve();
        write(turns, "log.md", "2\n");
      });
      await recorder.settle("main", "mv_1");

      await undoTurns(turns, "main", ["mv_1"]);
      expect(read(turns, "log.md")).toBe("0\n");
    } finally {
      spy.mockRestore();
    }
  });

  test("undoing a reply that committed in two tool calls moves HEAD back past both, and redo forward past both", async () => {
    const { turns, start } = await startedRepo();
    const recorder = new WorkspaceRecorder(turns);
    for (const name of ["a", "b"]) {
      await recorder.track(async () => {
        write(turns, `${name}.md`, `${name}\n`);
        gitIn(turns, "add", "-A");
        commit(turns, name);
      });
    }
    await recorder.settle("main", "mv_1");
    const end = await gitHead(turns.workspace);

    await undoTurns(turns, "main", ["mv_1"]);
    expect(await gitHead(turns.workspace)).toBe(start);
    expect(gitIn(turns, "status", "--porcelain")).toBe("");

    await redoTurns(turns, "main", ["mv_1"]);
    expect(await gitHead(turns.workspace)).toBe(end);
    expect(gitIn(turns, "status", "--porcelain")).toBe("");
  });

  test("undoing a reply whose tool call ran while an undo moved HEAD does not bring the undone commit back", async () => {
    const { turns, start } = await startedRepo();
    await turn(turns, "mv_1", () => {
      write(turns, "a.md", "a\n");
      gitIn(turns, "add", "-A");
      commit(turns, "a");
    });
    const recorder = new WorkspaceRecorder(turns);
    await recorder.track(async () => {
      write(turns, "c.md", "c\n");
      await undoTurns(turns, "main", ["mv_1"]);
    });
    await recorder.settle("side", "mv_2");
    expect(await gitHead(turns.workspace)).toBe(start);

    await undoTurns(turns, "side", ["mv_2"]);
    expect(existsSync(file(turns, "c.md"))).toBe(false);
    expect(await gitHead(turns.workspace)).toBe(start);
  });

  test("undoing a reply that committed while an undo of file changes ran still moves HEAD back", async () => {
    const { turns, start } = await startedRepo();
    await turn(turns, "mv_1", () => write(turns, "x.md", "x\n"));
    const recorder = new WorkspaceRecorder(turns);
    await recorder.track(async () => {
      await undoTurns(turns, "main", ["mv_1"]);
      write(turns, "b.md", "b\n");
      gitIn(turns, "add", "b.md");
      commit(turns, "b");
    });
    await recorder.settle("side", "mv_2");

    await undoTurns(turns, "side", ["mv_2"]);
    expect(existsSync(file(turns, "b.md"))).toBe(false);
    expect(existsSync(file(turns, "x.md"))).toBe(false);
    expect(await gitHead(turns.workspace)).toBe(start);
  });

  test("reply versions follow merged tool loops", () => {
    const toolUse: Message = { ...reply("mv_a"), content_blocks: [{ type: "tool_use", id: "t1", name: "read", input: {} }] };
    const toolResult: Message = { msg_id: "m_r", role: "user", content: "", images: [], content_blocks: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], timestamp: "", version: "mv_r" };
    expect(replyVersions([toolUse, toolResult, reply("mv_b")])).toEqual(["mv_b"]);
  });
});
