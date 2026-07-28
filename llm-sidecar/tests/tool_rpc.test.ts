/**
 * The sidecar's half of tool execution, against a fake daemon on a real socket.
 *
 * The distinction under test throughout is the one the daemon's protocol was
 * built around: a tool that *ran and failed* is a result the model is told
 * about, while a call that *never reached a loop* is a plumbing failure the
 * model must never see described as a tool failure.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolError } from "@anthropic-ai/sdk/resources/beta/messages";

import { callDaemonTool, daemonTools, ToolRpcUnreachable } from "../src/llm/tool_rpc.ts";
import type { ToolDefinition, ToolRpc } from "../src/llm/types.ts";

/** What the fake daemon should answer, or how it should misbehave. */
type Behaviour =
  | { kind: "answer"; body: unknown }
  | { kind: "raw"; body: string }
  | { kind: "close" }
  | { kind: "hang" };

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

/** A daemon that speaks the line-delimited protocol and answers per `behaviour`. */
function fakeDaemon(behaviour: Behaviour): FakeDaemon {
  const dir = mkdtempSync(join(tmpdir(), "shore-toolrpc-"));
  dirs.push(dir);
  const path = join(dir, "tools.sock");
  const seen: unknown[] = [];

  const server = Bun.listen<undefined>({
    unix: path,
    socket: {
      data(socket, chunk) {
        const line = new TextDecoder().decode(chunk).trim();
        try {
          seen.push(JSON.parse(line));
        } catch {
          seen.push(line);
        }
        switch (behaviour.kind) {
          case "answer":
            socket.write(`${JSON.stringify(behaviour.body)}\n`);
            socket.end();
            return;
          case "raw":
            socket.write(behaviour.body);
            socket.end();
            return;
          case "close":
            socket.end();
            return;
          case "hang":
            return;
        }
      },
    },
  });

  return { path, seen, stop: () => server.stop(true) };
}

const rpcFor = (daemon: FakeDaemon): ToolRpc => ({ socket_path: daemon.path, rid: "rid_1" });

const READ: ToolDefinition = {
  name: "read",
  description: "Read a file.",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
};

/** Run the single tool `daemonTools` produced, as the runner would. */
async function runTool(
  daemon: FakeDaemon,
  onUnreachable: (e: ToolRpcUnreachable) => void = () => {},
  input: unknown = { path: "/tmp/x" },
) {
  const [tool] = daemonTools([READ], rpcFor(daemon), onUnreachable);
  if (!tool) throw new Error("daemonTools produced no tool");
  return await tool.run(input, {
    toolUse: { type: "tool_use", id: "tu_1", name: "read", input },
    toolUseBlock: { type: "tool_use", id: "tu_1", name: "read", input },
  } as never);
}

describe("the call itself", () => {
  test("a request reaches the daemon and its answer comes back", async () => {
    const daemon = fakeDaemon({ kind: "answer", body: { output: "file body", is_error: false } });
    const outcome = await callDaemonTool(daemon.path, {
      rid: "rid_1",
      tool_id: "tu_1",
      name: "read",
      input: { path: "/tmp/x" },
    });

    expect(outcome).toEqual({ output: "file body", is_error: false });
    expect(daemon.seen).toEqual([
      { rid: "rid_1", tool_id: "tu_1", name: "read", input: { path: "/tmp/x" } },
    ]);
    daemon.stop();
  });

  test("an unreachable socket rejects rather than hanging", async () => {
    await expect(
      callDaemonTool("/nonexistent/shore-tools.sock", {
        rid: "rid_1",
        tool_id: "tu_1",
        name: "read",
        input: {},
      }),
    ).rejects.toBeInstanceOf(ToolRpcUnreachable);
  });

  test("a daemon that closes without answering rejects", async () => {
    const daemon = fakeDaemon({ kind: "close" });
    await expect(
      callDaemonTool(daemon.path, { rid: "rid_1", tool_id: "tu_1", name: "read", input: {} }),
    ).rejects.toBeInstanceOf(ToolRpcUnreachable);
    daemon.stop();
  });

  test("a non-JSON answer rejects rather than surfacing as a tool result", async () => {
    const daemon = fakeDaemon({ kind: "raw", body: "not json at all\n" });
    await expect(
      callDaemonTool(daemon.path, { rid: "rid_1", tool_id: "tu_1", name: "read", input: {} }),
    ).rejects.toBeInstanceOf(ToolRpcUnreachable);
    daemon.stop();
  });

  test("an already-aborted signal never opens a connection", async () => {
    const daemon = fakeDaemon({ kind: "answer", body: { output: "ok", is_error: false } });
    await expect(
      callDaemonTool(
        daemon.path,
        { rid: "rid_1", tool_id: "tu_1", name: "read", input: {} },
        AbortSignal.abort(),
      ),
    ).rejects.toBeInstanceOf(ToolRpcUnreachable);
    expect(daemon.seen).toEqual([]);
    daemon.stop();
  });

  test("aborting mid-call unblocks a daemon that never answers", async () => {
    // Cancellation's whole job: a turn cancelled while a tool is running must
    // not leave the sidecar parked on a socket read forever.
    const daemon = fakeDaemon({ kind: "hang" });
    const controller = new AbortController();
    const pending = callDaemonTool(
      daemon.path,
      { rid: "rid_1", tool_id: "tu_1", name: "read", input: {} },
      controller.signal,
    );
    await Bun.sleep(10);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ToolRpcUnreachable);
    daemon.stop();
  });
});

describe("what the model is told", () => {
  test("a tool that succeeded returns its output", async () => {
    const daemon = fakeDaemon({ kind: "answer", body: { output: "file body", is_error: false } });
    expect(await runTool(daemon)).toBe("file body");
    daemon.stop();
  });

  test("a tool that failed throws ToolError with the daemon's own text", async () => {
    // ToolError rather than a plain Error: the runner uses its content verbatim
    // and sets is_error, where a plain Error would reach the model reformatted
    // as "Error: no such file".
    const daemon = fakeDaemon({ kind: "answer", body: { output: "no such file", is_error: true } });
    const thrown = await runTool(daemon).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).content).toBe("no such file");
    daemon.stop();
  });

  test("a tool failure does NOT report the loop as unreachable", async () => {
    // The distinction the whole protocol exists for: a failed tool is a normal
    // result, so the turn continues.
    const daemon = fakeDaemon({ kind: "answer", body: { output: "boom", is_error: true } });
    const unreachable: ToolRpcUnreachable[] = [];
    await runTool(daemon, (e) => unreachable.push(e)).catch(() => {});
    expect(unreachable).toEqual([]);
    daemon.stop();
  });

  test("a call that never reached a loop reports unreachable", async () => {
    // The daemon's error shape. Feeding this to the model as a tool result
    // would describe a plumbing problem as something the model did, so the
    // turn is abandoned via onUnreachable instead.
    const daemon = fakeDaemon({ kind: "answer", body: { error: "no in-flight loop for rid rid_1" } });
    const unreachable: ToolRpcUnreachable[] = [];
    const thrown = await runTool(daemon, (e) => unreachable.push(e)).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ToolRpcUnreachable);
    expect(thrown).not.toBeInstanceOf(ToolError);
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]?.message).toContain("no in-flight loop");
    daemon.stop();
  });

  test("a dead socket reports unreachable too", async () => {
    const daemon = fakeDaemon({ kind: "close" });
    const unreachable: ToolRpcUnreachable[] = [];
    await runTool(daemon, (e) => unreachable.push(e)).catch(() => {});
    expect(unreachable).toHaveLength(1);
    daemon.stop();
  });
});

describe("the tool surface", () => {
  test("each definition becomes a tool the model addresses by name", async () => {
    const daemon = fakeDaemon({ kind: "answer", body: { output: "ok", is_error: false } });
    const write: ToolDefinition = {
      name: "write",
      description: "Write a file.",
      input_schema: { type: "object" },
    };
    const tools = daemonTools([READ, write], rpcFor(daemon), () => {});
    expect(tools.map((t) => t.name)).toEqual(["read", "write"]);
    // `description` lives on the custom-tool arm of the union, which is what
    // a daemon tool always is.
    expect((tools[0] as { description?: string } | undefined)?.description).toBe("Read a file.");
    daemon.stop();
  });

  test("the tool_use id and the loop's rid ride along on every call", async () => {
    // The daemon echoes tool_id into the result block and routes on rid; a
    // wrong id silently mispairs the result with the call.
    const daemon = fakeDaemon({ kind: "answer", body: { output: "ok", is_error: false } });
    await runTool(daemon);
    expect(daemon.seen[0]).toMatchObject({ rid: "rid_1", tool_id: "tu_1", name: "read" });
    daemon.stop();
  });

  test("input is forwarded verbatim — nothing here interprets a tool's arguments", async () => {
    const daemon = fakeDaemon({ kind: "answer", body: { output: "ok", is_error: false } });
    const input = { path: "/tmp/x", nested: { deep: [1, 2, 3] }, flag: false };
    await runTool(daemon, () => {}, input);
    expect((daemon.seen[0] as { input: unknown }).input).toEqual(input);
    daemon.stop();
  });
});
