import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, dispatchWithinDeadline, windowToolResult, withResultCeiling, type ToolContext } from "../src/tools/dispatch.ts";
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

  test("a long result is cut once, on line breaks, and its note counts exactly what is missing", async () => {
    const { run } = await world();
    const result = await run("seq 1 60000");
    const raw = result.raw;
    const head = raw.slice(0, raw.lastIndexOf("\n", 29_999) + 1);
    const tail = raw.slice(raw.indexOf("\n", raw.length - 20_001) + 1);
    const missing = raw.slice(head.length, raw.length - tail.length);
    const n = (value: number) => value.toLocaleString("en-US");
    const [lastShown, firstBack] = [Number(head.trimEnd().split("\n").at(-1)), Number(tail.split("\n")[0])];
    expect(lastShown).toBeGreaterThan(5_900);
    expect(firstBack).toBeGreaterThan(56_600);
    expect(head.length).toBeGreaterThan(29_990);
    expect(tail.length).toBeGreaterThan(19_990);
    expect(result.output).toBe(
      `${head.slice(0, -1)}\n\n[tool_result truncated: this result was too long, so its middle is left out here: ` +
      `${n(missing.length)} of its ${n(raw.length)} characters, ${n(firstBack - lastShown - 1)} lines. Nothing else is missing: ` +
      `the first ${n(head.length)} characters are above this note and the last ${n(tail.length)} are below it. ` +
      `To see the rest, narrow the call to a more specific path, pattern or range, or write the output to a file and read it in parts.]\n\n${tail}`,
    );
    expect(result.window).toEqual({ output: result.output, truncated: true, originalChars: raw.length, headChars: head.length, tailChars: tail.length });
  });

  test("a result with no line break near the cut is cut inside a line and says so, and one that fits is left alone", () => {
    const note = (size: string, shown: string, part = "middle") =>
      `[tool_result truncated: this result was too long, so its ${part} is left out here: ${size}. Nothing else is missing: ${shown}. ` +
      `To see the rest, narrow the call to a more specific path, pattern or range, or write the output to a file and read it in parts.]`;
    const both = (head: number, tail: number) => `the first ${String(head)} characters are above this note and the last ${String(tail)} are below it`;
    const inside = (gone: number, all: number) => `${String(gone)} of its ${String(all)} characters; the cut falls inside a line`;
    const cut = (text: string, max = 10) => windowToolResult(text, max).output;

    expect(cut("x".repeat(100))).toBe(`xxxxxx\n\n${note(inside(90, 100), both(6, 4))}\n\nxxxx`);
    expect(cut(`abc\n${"x".repeat(96)}`)).toBe(`abc\n\n${note(inside(92, 100), both(4, 4))}\n\nxxxx`);
    expect(cut(`ab\n${"x".repeat(97)}`)).toBe(`ab\nxxx\n\n${note(inside(90, 100), both(6, 4))}\n\nxxxx`);
    expect(cut(`${"x".repeat(96)}\nabc`)).toBe(`xxxxxx\n\n${note(inside(90, 100), both(6, 4))}\n\nabc`.replace("last 4", "last 3").replace("90 of", "91 of"));
    expect(cut(`${"x".repeat(95)}\nabcd`)).toBe(`xxxxxx\n\n${note(inside(90, 100), both(6, 4))}\n\nabcd`);
    expect(cut(`${"x".repeat(97)}\nab`)).toBe(`xxxxxx\n\n${note(inside(90, 100), both(6, 4))}\n\nx\nab`);
    expect(cut("aaaaa\nbbbbb\nccccc\nddd")).toBe(`aaaaa\n\n${note("12 of its 21 characters, 2 lines", both(6, 3))}\n\nddd`);
    expect(cut("aaaaa\nbbbbb\ncc\ndd", 14)).toBe(`aaaaa\n\n${note("6 of its 17 characters, 1 line", both(6, 5))}\n\ncc\ndd`);
    expect(cut("ab\ncd\nef", 1)).toBe(`a\n\n${note("7 of its 8 characters; the cut falls inside a line", "only the first 1 characters are shown", "end")}`);
    expect(cut("a\nbbbbbbb", 2)).toBe(`a\n\n${note("7 of its 9 characters, 0 lines", "only the first 2 characters are shown", "end")}`);
    expect(cut(`abcd\n${"x".repeat(95)}`)).toBe(`abcd\n\n${note(inside(91, 100), both(5, 4))}\n\nxxxx`);
    expect(cut(`${"x".repeat(92)}\n${"y".repeat(7)}`, 30)).toBe(`${"x".repeat(18)}\n\n${note(inside(75, 100), both(18, 7))}\n\nyyyyyyy`);
    expect(cut(`${"x".repeat(93)}\n${"y".repeat(6)}`, 30)).toBe(`${"x".repeat(18)}\n\n${note(inside(70, 100), both(18, 12))}\n\nxxxxx\nyyyyyy`);
    expect(cut("a\nbbbbbbbb", 3)).toBe(`a\n\n${note(inside(7, 10), both(2, 1))}\n\nb`);
    expect(cut("😀".repeat(20))).toBe(`${"😀".repeat(6)}\n\n${note(inside(10, 20), both(6, 4))}\n\n${"😀".repeat(4)}`);

    expect(windowToolResult("0123456789", 10)).toEqual({ output: "0123456789", truncated: false, originalChars: 10, headChars: 10, tailChars: 0 });
    expect(windowToolResult("x".repeat(100), 0).output).toBe("x".repeat(100));
    expect(windowToolResult("x".repeat(100), 10)).toMatchObject({ truncated: true, originalChars: 100, headChars: 6, tailChars: 4 });
  });

  test("a provider's own ceiling replaces a larger or absent limit, so the result is cut once", async () => {
    const { run, exec } = await world();
    const shown = async (ceiling?: number) => {
      const result = await (ceiling === undefined ? run("seq 1 1000") : withResultCeiling(ceiling, () => run("seq 1 1000")));
      const notes = result.output.match(/\[tool_result truncated/g) ?? [];
      return { notes: notes.length, kept: (result.window?.headChars ?? 0) + (result.window?.tailChars ?? 0) };
    };
    const whole = (await run("seq 1 1000")).raw.length;
    const capped = await shown(1_000);
    expect(capped.notes).toBe(1);
    expect(capped.kept).toBeLessThanOrEqual(1_000);
    expect(capped.kept).toBeGreaterThan(990);
    exec.limits.max_result_chars = 0;
    expect(await shown(1_000)).toEqual(capped);
    expect(await shown()).toEqual({ notes: 0, kept: whole });
    exec.limits.max_result_chars = 500;
    expect((await shown(1_000)).kept).toBeLessThanOrEqual(500);
    expect((await shown(1_000)).kept).toBeGreaterThan(450);
    exec.limits.max_result_chars = 1_000;
    exec.limits.config = { bash: { max_result_chars: 2_000 } };
    expect((await shown()).kept).toBeGreaterThan(1_900);
    expect(await shown(1_000)).toEqual(capped);
  });

  test("a command that times out returns what it printed before it was stopped", async () => {
    const { run, exec } = await world();
    exec.limits.timeout_ms = 400;
    const stopped = async (command: string) => {
      const result = await run(`${command}; sleep 10`);
      expect(result.isError).toBe(true);
      return result.output;
    };
    expect(await stopped("echo one; echo two >&2")).toBe("timed out after 0s and was cancelled\nOutput before it was stopped:\none\nstderr:\ntwo");
    expect(await stopped("echo one; echo")).toBe("timed out after 0s and was cancelled\nOutput before it was stopped:\none\n");
    expect(await stopped("echo two >&2")).toBe("timed out after 0s and was cancelled\nOutput before it was stopped:\nstderr:\ntwo");
    expect(await stopped("true")).toBe("timed out after 0s and was cancelled\nIt printed nothing before it was stopped.");
  });
});
