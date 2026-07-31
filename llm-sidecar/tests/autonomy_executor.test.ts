/**
 * Asking the daemon to run an autonomy action, against a fake daemon on a real
 * socket.
 *
 * The distinction under test is the one the seam is built around, and it is the
 * same one tool calls draw: an action that *ran and failed* is a result the tick
 * folds in — log lines kept, latch released, retry window restarted — while a
 * call that *never reached a character* is a plumbing failure that abandons the
 * rest of the tick.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  actionForCompaction,
  decodeActionResult,
  RpcAutonomyExecutor,
} from "../src/autonomy/executor.ts";
import { ToolRpcUnreachable } from "../src/llm/tool_rpc.ts";

interface FakeDaemon {
  path: string;
  /** Requests seen, in order, as parsed JSON. */
  seen: unknown[];
  stop(): void;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A daemon that answers every action with the same body. */
function fakeDaemon(body: unknown): FakeDaemon {
  const dir = mkdtempSync(join(tmpdir(), "shore-autonomy-rpc-"));
  dirs.push(dir);
  const path = join(dir, "tools.sock");
  const seen: unknown[] = [];

  const server = Bun.listen<undefined>({
    unix: path,
    socket: {
      data(socket, chunk) {
        seen.push(JSON.parse(new TextDecoder().decode(chunk).trim()));
        socket.write(`${JSON.stringify(body)}\n`);
        socket.end();
      },
    },
  });

  return { path, seen, stop: () => server.stop(true) };
}

describe("what goes out", () => {
  test("the action names the compaction reason rather than carrying it", async () => {
    const daemon = fakeDaemon({});
    try {
      const executor = new RpcAutonomyExecutor(daemon.path);
      await executor.runCompaction("nova", "max_turns");
      await executor.runCompaction("nova", "idle");
      expect(daemon.seen).toEqual([
        { kind: "autonomy", character: "nova", action: "compact_max_turns" },
        { kind: "autonomy", character: "nova", action: "compact_idle" },
      ]);
    } finally {
      daemon.stop();
    }
  });

  test("every action reaches the socket under its own name", async () => {
    const daemon = fakeDaemon({});
    try {
      const executor = new RpcAutonomyExecutor(daemon.path);
      await executor.runHeartbeatTick("nova");
      await executor.runDeepArchive("nova");
      await executor.runDream("nova");
      expect(daemon.seen.map((r) => (r as { action: string }).action)).toEqual([
        "heartbeat_tick",
        "deep_archive",
        "dream",
      ]);
    } finally {
      daemon.stop();
    }
  });

  test("the two compaction reasons map to the two actions", () => {
    expect(actionForCompaction("max_turns")).toBe("compact_max_turns");
    expect(actionForCompaction("idle")).toBe("compact_idle");
  });
});

describe("what comes back", () => {
  test("an action that worked reports what it changed", async () => {
    const daemon = fakeDaemon({
      turn_count: 4,
      events: [{ kind: "message_sent", detail: "Autonomous message sent: hello" }],
    });
    try {
      const result = await new RpcAutonomyExecutor(daemon.path).runHeartbeatTick("nova");
      expect(result).toEqual({
        turnCount: 4,
        events: [{ kind: "message_sent", detail: "Autonomous message sent: hello" }],
        failed: undefined,
      });
    } finally {
      daemon.stop();
    }
  });

  test("an action that ran and failed is a result, not a throw", async () => {
    // Its log lines still have to reach the log, and its latch still has to
    // release. A throw would lose both and stop the rest of the tick.
    const daemon = fakeDaemon({
      failed: "no conversation to compact",
      events: [{ kind: "timeout", detail: "compaction gave up" }],
    });
    try {
      const result = await new RpcAutonomyExecutor(daemon.path).runCompaction("nova", "idle");
      expect(result.failed).toBe("no conversation to compact");
      expect(result.events).toEqual([{ kind: "timeout", detail: "compaction gave up" }]);
    } finally {
      daemon.stop();
    }
  });

  test("a character the daemon does not have is a throw", async () => {
    const daemon = fakeDaemon({ error: "character ghost is not loaded" });
    try {
      await expect(
        new RpcAutonomyExecutor(daemon.path).runDream("ghost"),
      ).rejects.toThrow("character ghost is not loaded");
    } finally {
      daemon.stop();
    }
  });

  test("a socket nobody is listening on is a throw", async () => {
    const executor = new RpcAutonomyExecutor(join(tmpdir(), "shore-no-such-daemon.sock"));
    await expect(executor.runDream("nova")).rejects.toBeInstanceOf(ToolRpcUnreachable);
  });
});

describe("reading the answer", () => {
  const decode = (outcome: unknown) => decodeActionResult(outcome, "nova", "dream");

  test("an empty body is a plain success", () => {
    // What the daemon sends for an action that worked and changed nothing
    // worth reporting: both fields are `skip_serializing_if` on that side.
    expect(decode({})).toEqual({ turnCount: undefined, events: [], failed: undefined });
  });

  test("a kind the log does not know is dropped, not raised", () => {
    // Same forgiveness a line read back off disk gets. Raising would turn one
    // bad log entry into a failed autonomy action.
    const result = decode({
      events: [
        { kind: "invented_kind", detail: "?" },
        { kind: "wake", detail: "the user returned" },
      ],
    });
    expect(result.events).toEqual([{ kind: "wake", detail: "the user returned" }]);
  });

  test("malformed entries are skipped without taking the good ones with them", () => {
    const result = decode({
      events: [null, "not an object", { kind: "dormant" }, { detail: "no kind" }, 7],
    });
    expect(result.events).toEqual([]);
  });

  test("events that are not a list read as none", () => {
    expect(decode({ events: "tick_fired" }).events).toEqual([]);
  });

  test("a turn count of the wrong type reads as absent rather than as zero", () => {
    // Zero would be a real answer — "the conversation is empty now" — and
    // acting on it would blank a count that is simply unknown.
    expect(decode({ turn_count: "4" }).turnCount).toBeUndefined();
  });

  test("an answer that is not an object at all is a throw", () => {
    expect(() => decode("ok")).toThrow(ToolRpcUnreachable);
    expect(() => decode(null)).toThrow(ToolRpcUnreachable);
  });
});
