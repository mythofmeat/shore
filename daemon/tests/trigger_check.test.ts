import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { runCheck, type CheckOutcome } from "../src/autonomy/trigger_check.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

async function check(command: string, options: { limitMs?: number; signal?: AbortSignal; dir?: string } = {}): Promise<{ outcome: CheckOutcome; dir: string }> {
  const dir = options.dir ?? await mkdtemp(testTmp("shore-trigger-check-"));
  const outcome = await runCheck({
    workspace: new CharacterWorkspace(dir),
    character: "ada",
    trigger: "tide-table",
    command,
    facts: { user: { last_message_at: "2026-10-30T12:00:00.000Z" } },
    env: { SHORE_USER_QUIET_SECS: "600" },
    limitMs: options.limitMs ?? 30_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { outcome, dir };
}

test("a check that prints nothing is quiet, and one that prints something fires with what it printed", async () => {
  expect((await check("true")).outcome).toEqual({ kind: "quiet" });
  expect((await check("printf '  \\n\\n'")).outcome).toEqual({ kind: "quiet" });
  expect((await check("echo noise >&2")).outcome).toEqual({ kind: "quiet" });
  expect((await check("printf '\\n the tide is out \\n\\n'")).outcome).toEqual({ kind: "fired", output: "the tide is out" });
});

test("what a check printed is cut at 2,000 characters, counting characters and not bytes", async () => {
  expect((await check("for i in $(seq 2000); do printf 🕯; done")).outcome).toEqual({ kind: "fired", output: "🕯".repeat(2000) });
  expect((await check("for i in $(seq 2001); do printf 🕯; done")).outcome).toEqual({ kind: "fired", output: `${"🕯".repeat(2000)}… [cut]` });
});

test("a check that exits with an error has failed, whatever it printed, and says what it wrote to stderr", async () => {
  expect((await check("echo found something; exit 3")).outcome).toEqual({ kind: "failed", problem: "it exited with status 3" });
  expect((await check("echo ' no such host ' >&2; exit 1")).outcome).toEqual({ kind: "failed", problem: "it exited with status 1: no such host" });
  expect((await check("false | true")).outcome).toEqual({ kind: "failed", problem: "it exited with status 1" });
  expect((await check("for i in $(seq 501); do printf e >&2; done; exit 2")).outcome).toEqual({ kind: "failed", problem: `it exited with status 2: ${"e".repeat(500)}… [cut]` });
  expect((await check("for i in $(seq 500); do printf e >&2; done; exit 2")).outcome).toEqual({ kind: "failed", problem: `it exited with status 2: ${"e".repeat(500)}` });
});

test("a check still running at its limit is stopped and has failed", async () => {
  const started = performance.now();
  expect((await check("sleep 30", { limitMs: 300 })).outcome).toEqual({ kind: "failed", problem: "it was still running at its time limit and was stopped" });
  expect(performance.now() - started).toBeLessThan(10_000);
});

test("a check that can't be started has failed, and one stopped because Shore is shutting down is not reported as failed", async () => {
  const missing = join(await mkdtemp(testTmp("shore-trigger-check-")), "gone");
  const { outcome } = await check("true", { dir: missing });
  expect(outcome.kind).toBe("failed");
  const problem = outcome.kind === "failed" ? outcome.problem : "";
  expect(problem).toStartWith("it could not be run: ");
  expect(problem).toContain("ENOENT");
  expect(problem).not.toContain("Error: ");

  const stop = new AbortController();
  const running = check("sleep 30", { signal: stop.signal });
  setTimeout(() => { stop.abort(new Error("shutting down")); }, 100);
  expect(await rejectionOf(running)).toMatchObject({ message: "shutting down" });
});

test("a check runs in the workspace with the bash tool's environment, the trigger's name, and what Shore knows on stdin", async () => {
  const { outcome, dir } = await check('printf "%s|%s|%s|%s|%s|%s|" "$SHORE_TRIGGER" "$SHORE_USER_QUIET_SECS" "$SHORE_WORKSPACE_DIR" "$PWD" "$(pwd)" "$GIT_AUTHOR_NAME"; cat');
  expect(outcome).toEqual({
    kind: "fired",
    output: `tide-table|600|${dir}|${dir}|${dir}|ada|{"user":{"last_message_at":"2026-10-30T12:00:00.000Z"}}`,
  });
});
