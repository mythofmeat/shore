import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, dispatchWithinDeadline, type ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return String(error); }
  throw new Error("expected the operation to fail");
}

async function world() {
  const root = await mkdtemp(join(tmpdir(), "shore-bash-"));
  const workspaceDir = join(root, "workspace");
  const ctx: ToolContext = {
    workspaceDir, characterName: "Juniper Vale", characterDataDir: root,
    imageDir: root, conversationDir: root, historyDbPath: join(root, "history.db"), configDir: root,
  };
  const frames: ServerMessage[] = [];
  const exec: ToolExecution = {
    ctx, sendDirect: (frame) => frames.push(frame), schemas: BUILTIN_TOOL_SCHEMAS,
    limits: { max_result_chars: 50_000, timeout_ms: 5_000 },
    now: () => new Date().toISOString(), newMessageId: () => "unused",
  };
  const run = (command: string, workdir?: string) => runToolUse({
    id: "bash-call", name: "bash", input: { command, ...(workdir === undefined ? {} : { workdir }) },
  }, exec, []);
  return { root, ctx, exec, frames, run };
}

describe("bash on Shore's tool surface", () => {

  test.each([{}, { command: 42 }, { command: "" }, { command: "pwd", workdir: 3 }, { command: "pwd", surprise: true }])(
    "rejects malformed input before touching the workspace: %j", async (input) => {
      const { exec, ctx } = await world();
      const result = await runToolUse({ id: "bad", name: "bash", input }, exec, []);
      expect(result.rejected).toBe(true);
      expect(result.isError).toBe(true);
      expect(await Bun.file(join(ctx.workspaceDir, "marker")).exists()).toBe(false);
    },
  );

  test("returns nonzero exit status and both output streams to the model", async () => {
    const { run } = await world();
    const result = await run("printf out; printf err >&2; exit 7");
    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({ exit_code: 7, stdout: "out", stderr: "err" });
    expect(result.raw).toContain("bash: exit 7");
    expect(result.block).toMatchObject({ is_error: true });
    expect((await run("false | cat")).isError).toBe(true);
  });

  test("stdin is closed instead of waiting for user input", async () => {
    const { run } = await world();
    expect((await run("if read -r value; then exit 9; fi; printf closed")).raw).toContain("closed");
  });

  test("bounds captured output while continuing to drain stdout and stderr", async () => {
    const { run, exec } = await world();
    exec.limits.max_result_chars = 200;
    const result = await run("head -c 1100000 /dev/zero | tr '\\0' x; head -c 1100000 /dev/zero | tr '\\0' y >&2; printf done > done.txt");
    expect(result.isError).toBe(false);
    expect(result.raw.length).toBeLessThan(2 * 1024 * 1024 + 1000);
    expect(result.raw).toContain("[process output truncated]");
    expect(result.window?.truncated).toBe(true);
    expect((await run("cat done.txt")).raw).toContain("done");
  });

  test("dry-run blocks Bash before creating any files", async () => {
    const { ctx } = await world();
    ctx.dryRun = true;
    expect(await failure(dispatchTool("bash", { command: "touch marker" }, ctx))).toContain("dry-run");
    expect(await Bun.file(join(ctx.workspaceDir, "marker")).exists()).toBe(false);
  });

  test("timeout kills descendants and queues edits made before cancellation", async () => {
    const { ctx } = await world();
    const queued: string[] = [];
    ctx.deferEdit = (path) => { queued.push(path); };
    expect(await failure(dispatchWithinDeadline("bash", {
      command: "printf partial > MEMORY.md; (trap '' TERM; sleep 1; printf leaked > leaked.txt) & wait",
    }, ctx, 150))).toContain("timed out");
    await Bun.sleep(1100);
    expect(await readFile(join(ctx.workspaceDir, "MEMORY.md"), "utf8")).toBe("partial");
    expect(queued).toEqual(["MEMORY.md"]);
    expect(await Bun.file(join(ctx.workspaceDir, "leaked.txt")).exists()).toBe(false);
  });

  test("caller cancellation reaches the command and its child processes", async () => {
    const { ctx } = await world();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const call = dispatchTool("bash", { command: "printf ready > ready; sleep 10; touch leaked" }, ctx);
    for (let attempts = 0; attempts < 100 && !await Bun.file(join(ctx.workspaceDir, "ready")).exists(); attempts += 1) await Bun.sleep(10);
    controller.abort(new Error("user cancelled"));
    expect(await failure(call)).toContain("user cancelled");
    expect(await Bun.file(join(ctx.workspaceDir, "leaked")).exists()).toBe(false);
  });
});
