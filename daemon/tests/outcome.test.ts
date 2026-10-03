import { describe, expect, expectTypeOf, test } from "bun:test";
import { join } from "node:path";

import { outcomeOf, rejectionOf } from "./support/outcome.ts";

const DAEMON_DIR = new URL("..", import.meta.url).pathname;
const NEVER_SETTLING = join(import.meta.dir, "support", "never_settling_assertions.ts");
const NEVER_SETTLING_TESTS = 3;
const NEVER_SETTLING_TIMEOUT_MS = 100;
const HANG_GUARD_MS = 30_000;

interface ChildRun {
  readonly code: number;
  readonly signalCode: NodeJS.Signals | null;
  readonly report: string;
  readonly timeouts: number;
  readonly cpuMicroseconds: number | undefined;
}

async function runNeverSettlingTests(): Promise<ChildRun> {
  const child = Bun.spawn([process.execPath, "test", NEVER_SETTLING], { cwd: DAEMON_DIR, stdout: "pipe", stderr: "pipe" });
  const guard = setTimeout(() => child.kill("SIGKILL"), HANG_GUARD_MS);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(guard);
  const report = stdout + stderr;
  return {
    code,
    signalCode: child.signalCode,
    report,
    timeouts: report.split(`this test timed out after ${String(NEVER_SETTLING_TIMEOUT_MS)}ms`).length - 1,
    cpuMicroseconds: child.resourceUsage()?.cpuTime.total,
  };
}

describe("outcomeOf", () => {
  test("replays a rejection as a throw that toThrow matches", async () => {
    const replay = await outcomeOf(Promise.reject(new TypeError("the socket closed")));
    expect(replay).toThrow(TypeError);
    expect(replay).toThrow("socket closed");
    expect(replay).not.toThrow("timed out");
  });

  test("replays a fulfilment as its value without throwing", async () => {
    const replay = await outcomeOf(Promise.resolve(7));
    expect(replay).not.toThrow();
    expect(replay()).toBe(7);
  });
});

describe("rejectionOf", () => {
  test("gives the reason a promise rejected with", async () => {
    const reason = new RangeError("too far");
    expect(await rejectionOf(Promise.reject(reason))).toBe(reason);
  });

  test("fails, naming the value, when the promise resolves", async () => {
    expect(await outcomeOf(rejectionOf(Promise.resolve("fine")))).toThrow('Received promise that resolved: "fine"');
  });
});

describe("toThrow on a function that may return a promise", () => {
  test("cannot be called, so no promise is waited for where the test's timeout cannot stop it", () => {
    const promised = (): Promise<number> => Promise.resolve(7);
    const promisedOrNot = (): number | Promise<number> => 7;

    expectTypeOf(expect(promised).toThrow).not.toBeFunction();
    expectTypeOf(expect(promised).toThrowError).not.toBeFunction();
    expectTypeOf(expect(promised).toThrowErrorMatchingSnapshot).not.toBeFunction();
    expectTypeOf(expect(promised).toThrowErrorMatchingInlineSnapshot).not.toBeFunction();
    expectTypeOf(expect(promised).not.toThrow).not.toBeFunction();
    expectTypeOf(expect(promisedOrNot).toThrow).not.toBeFunction();
    expectTypeOf(expect(async () => {}).toThrow).not.toBeFunction();
  });
});

test("a promise that never settles fails its test at the test's timeout, and the run finishes", async () => {
  const { code, signalCode, report, timeouts } = await runNeverSettlingTests();
  expect(signalCode, report).toBeNull();
  expect(code, report).toBe(1);
  expect(timeouts, report).toBe(NEVER_SETTLING_TESTS);
  expect(report, report).toContain(" 0 pass");
}, HANG_GUARD_MS + 5_000);

test("tests waiting on promises that never settle leave the CPU idle until they time out", async () => {
  const { report, timeouts, cpuMicroseconds } = await runNeverSettlingTests();
  const waitedMicroseconds = NEVER_SETTLING_TESTS * NEVER_SETTLING_TIMEOUT_MS * 1000;
  expect(timeouts, report).toBe(NEVER_SETTLING_TESTS);
  expect(cpuMicroseconds, report).toBeLessThan(waitedMicroseconds / 2);
}, HANG_GUARD_MS + 5_000);
