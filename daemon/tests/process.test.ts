import { describe, expect, jest, test } from "bun:test";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";

import { envWithoutInheritedGitRepo, KILL_GRACE_MS, OUTPUT_LIMIT_BYTES, runProcess } from "../src/tools/process.ts";
import { setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";
import { untilAsync } from "./support/until.ts";

const bun = process.execPath;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !/^\d+ \(.*\) Z/u.test(readFileSync(`/proc/${String(pid)}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function readPid(path: string): Promise<number> {
  let pid = Number.NaN;
  await untilAsync(async () => {
    pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
    return Number.isInteger(pid) && pid > 0;
  }, `a pid in ${path}`);
  return pid;
}

describe("runProcess", () => {
  test("a process's exit code and output come back, with its input passed in", async () => {
    expect(await runProcess(bun, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], {})).toEqual({ code: 3, stdout: "out", stderr: "err" });
    expect(await runProcess("cat", [], { stdin: "fed in" })).toEqual({ code: 0, stdout: "fed in", stderr: "" });
  });

  test("a process that exits without reading its input is not an error", async () => {
    expect(await runProcess("true", [], { stdin: "x".repeat(4 * 1024 * 1024) })).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("a program that doesn't exist is reported", async () => {
    const failure = await runProcess(join(await mkdtemp(testTmp("process-")), "missing"), [], {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("output beyond the limit is cut off and marked, on both streams; output exactly at the limit is not", async () => {
    const write = (bytes: number): string => `process.stdout.write("x".repeat(${String(bytes)})); process.stderr.write("y".repeat(${String(bytes)}))`;
    const exact = await runProcess(bun, ["-e", write(OUTPUT_LIMIT_BYTES)], {});
    expect(exact.stdout).toBe("x".repeat(OUTPUT_LIMIT_BYTES));
    expect(exact.stderr).toBe("y".repeat(OUTPUT_LIMIT_BYTES));
    const over = await runProcess(bun, ["-e", write(OUTPUT_LIMIT_BYTES + 1)], {});
    expect(over.stdout).toBe(`${"x".repeat(OUTPUT_LIMIT_BYTES)}\n[process output truncated]`);
    expect(over.stderr).toBe(`${"y".repeat(OUTPUT_LIMIT_BYTES)}\n[process output truncated]`);
    expect(OUTPUT_LIMIT_BYTES).toBe(1024 * 1024);
  });

  test("a process asked for after the stop never starts", async () => {
    const ran = join(await mkdtemp(testTmp("process-")), "ran");
    const stop = new AbortController();
    stop.abort(new Error("stopped first"));
    const failure = await runProcess(bun, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "yes")`], { signal: stop.signal }).catch((error: unknown) => error);
    expect(failure).toBe(stop.signal.reason);
    expect(await Bun.file(ran).exists()).toBe(false);
  });

  test("stopping asks politely first, so a process can clean up", async () => {
    const dir = await mkdtemp(testTmp("process-"));
    const [ready, cleaned] = [join(dir, "ready"), join(dir, "cleaned")];
    const stop = new AbortController();
    const work = runProcess(bun, ["-e", `
      const fs = require("node:fs");
      process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(cleaned)}, "done"); process.exit(0); });
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setInterval(() => {}, 1000);
    `], { signal: stop.signal }).catch((error: unknown) => error);
    await readPid(ready);
    stop.abort();
    expect(await work).toBe(stop.signal.reason);
    expect(await readFile(cleaned, "utf8")).toBe("done");
  });

  test("a process that ignores the polite stop is killed once the grace period runs out", async () => {
    const ready = join(await mkdtemp(testTmp("process-")), "ready");
    const stop = new AbortController();
    const work = runProcess(bun, ["-e", `
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setInterval(() => {}, 1000);
    `], { signal: stop.signal }).catch((error: unknown) => error);
    const pid = await readPid(ready);
    jest.useFakeTimers();
    try {
      stop.abort();
      jest.advanceTimersByTime(KILL_GRACE_MS - 1);
      expect(alive(pid)).toBe(true);
      jest.advanceTimersByTime(1);
      expect(await work).toBe(stop.signal.reason);
    } finally {
      jest.useRealTimers();
    }
    expect(alive(pid)).toBe(false);
    expect(KILL_GRACE_MS).toBe(250);
  });

  test("stopping reaches everything the process started, even what ignores the polite stop", async () => {
    const pidfile = join(await mkdtemp(testTmp("process-")), "grandchild");
    const stop = new AbortController();
    const work = runProcess("sh", ["-c", `(trap "" TERM; exec sleep 30) > /dev/null 2>&1 & echo $! > ${JSON.stringify(pidfile)}; wait`], { signal: stop.signal }).catch((error: unknown) => error);
    const grandchild = await readPid(pidfile);
    stop.abort();
    expect(await work).toBe(stop.signal.reason);
    await untilAsync(() => Promise.resolve(!alive(grandchild)), "the grandchild dying");
  });

  test("a finished process stops listening for a stop", async () => {
    const stop = new AbortController();
    await runProcess("true", [], { signal: stop.signal });
    expect(getEventListeners(stop.signal, "abort")).toEqual([]);
  });
});

describe("envWithoutInheritedGitRepo", () => {
  test("git run for a workspace doesn't inherit the location of an outer repository", () => {
    const outer = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES"];
    for (const name of outer) setTestEnv(name, `/outer/${name}`);
    setTestEnv("GIT_AUTHOR_NAME", "Ada");
    const env = envWithoutInheritedGitRepo();
    for (const name of outer) expect(env[name]).toBeUndefined();
    expect(env["GIT_AUTHOR_NAME"]).toBe("Ada");
    expect(env["PATH"]).toBe(process.env["PATH"]);
    expect(process.env["GIT_DIR"]).toBe("/outer/GIT_DIR");
  });
});
