import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";

import { runningReport } from "../src/daemon/running.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = Date.UTC(2026, 10, 17, 12);

test("what is running is listed oldest first, each with how many whole seconds it has run, and a start the clock hasn't reached yet counts as none", async () => {
  const dataDir = await mkdtemp(testTmp("shore-running-"));
  const report = runningReport({
    dataDir,
    generations: () => [{ character: "ada", thread: "ring", startedAt: NOW - 1_000 }, { character: "bo", thread: null, startedAt: NOW + 5_000 }],
    wakes: () => [{ character: "ada", startedAt: NOW - 90_500 }],
    shutdown: () => undefined,
    now: () => NOW,
  });
  expect(report).toEqual({
    work: [
      { kind: "wake", character: "ada", thread: null, started_at: "2026-11-17T11:58:29.500+00:00", running_secs: 90 },
      { kind: "message", character: "ada", thread: "ring", started_at: "2026-11-17T11:59:59+00:00", running_secs: 1 },
      { kind: "message", character: "bo", thread: null, started_at: "2026-11-17T12:00:05+00:00", running_secs: 0 },
    ],
    shutdown: null,
  });
});

test("a shutdown that is waiting on the work says when it was asked for and when it gives up", async () => {
  const dataDir = await mkdtemp(testTmp("shore-running-"));
  const report = runningReport({
    dataDir,
    generations: () => [],
    wakes: () => [],
    shutdown: () => ({ requestedAt: NOW, deadline: NOW + 30_000 }),
    now: () => NOW,
  });
  expect(report).toEqual({ work: [], shutdown: { requested_at: "2026-11-17T12:00:00+00:00", deadline: "2026-11-17T12:00:30+00:00" } });
});
