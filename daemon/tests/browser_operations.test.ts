import { describe, expect, test } from "bun:test";

import type { BrowserConnection, BrowserRequest, ConnectionUpdate } from "../src/browser/connection.ts";
import { OperationClient, OperationFailure } from "../src/browser/operations.ts";
import { archiveStatus, parsePairs, requestStatus, sourceLabel } from "../src/browser/settings/format.ts";
import type { RequestFinished } from "../src/protocol/RequestFinished.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { WebArchiveInfo } from "../src/protocol/WebArchiveInfo.ts";
import type { WebRequestInfo } from "../src/protocol/WebRequestInfo.ts";

function daemon(answer: (request: BrowserRequest, rid: string) => { frames: Record<string, unknown>[]; finished: RequestFinished["outcome"]; error?: string }) {
  const listeners = new Set<(update: ConnectionUpdate) => void>();
  let next = 0;
  const fake = {
    subscribe: (listener: (update: ConnectionUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submit: (request: BrowserRequest) => {
      const rid = `r_${String(next += 1)}`;
      const reply = answer(request, rid);
      const finished = (async () => {
        await Bun.sleep(0);
        for (const frame of reply.frames) for (const listener of listeners) listener({ kind: "frame", message: frame } as ConnectionUpdate);
        return { rid, outcome: reply.finished, ...(reply.error === undefined ? {} : { error: { code: "invalid_request", message: reply.error } }) } as RequestFinished;
      })();
      return { rid, finished };
    },
  };
  return { connection: fake as unknown as BrowserConnection, listeners };
}

const characters = { characters: [{ name: "ada" }] };

describe("running an action", () => {
  test("returns the action's own output and passes every frame for its request to an observer", async () => {
    const link = daemon((request, rid) => ({
      frames: [
        { type: "phase", rid: "someone-else", phase: "x" },
        { type: "command_output", rid: "someone-else", name: "list_characters", data: { characters: [] } },
        { type: "phase", rid, phase: "listing" },
        { type: "command_output", rid, name: "list_characters", data: characters },
      ],
      finished: "completed",
    }));
    const client = new OperationClient(link.connection);
    const seen: ServerMessage[] = [];
    const listing = client.run("list_characters", {}, { observe: (message) => { seen.push(message); } });
    expect(client.pendingOperation("r_1")).toBe("list_characters");
    expect(await listing).toEqual(characters);
    expect(seen.map((message) => message.type)).toEqual(["phase", "command_output"]);
    expect(client.pendingOperation("r_1")).toBeUndefined();
    expect(client.pendingOperation(null)).toBeUndefined();
    expect(client.pendingOperation(undefined)).toBeUndefined();
    expect(link.listeners.size, "it stops listening once done").toBe(0);
  });

  test("refuses arguments the action does not take, before sending anything", async () => {
    let sent = 0;
    const client = new OperationClient(daemon(() => { sent += 1; return { frames: [], finished: "completed" }; }).connection);
    expect(await client.run("list_characters", { surprise: true } as never).then(() => "", (error: unknown) => String(error))).toBe("Error: Invalid arguments for list_characters");
    expect(sent).toBe(0);
  });

  test("an output that is missing, doubled, from another action or malformed is no result", async () => {
    const outputs: [string, (rid: string) => Record<string, unknown>[]][] = [
      ["missing", () => []],
      ["doubled", (rid) => [{ type: "command_output", rid, name: "list_characters", data: characters }, { type: "command_output", rid, name: "list_characters", data: characters }]],
      ["another action's", (rid) => [{ type: "command_output", rid, name: "list_threads", data: characters }]],
      ["malformed", (rid) => [{ type: "command_output", rid, name: "list_characters", data: { characters: "ada" } }]],
    ];
    for (const [what, frames] of outputs) {
      const client = new OperationClient(daemon((_request, rid) => ({ frames: frames(rid), finished: "completed" })).connection);
      expect(await client.run("list_characters", {}).then(() => "", (error: unknown) => String(error)), what).toBe("Error: Invalid result for list_characters");
    }
  });

  test("an action that does not complete fails with the daemon's reason, or its outcome", async () => {
    const failing = new OperationClient(daemon(() => ({ frames: [], finished: "failed", error: "no such character" })).connection);
    const failure = await failing.run("list_characters", {}).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(OperationFailure);
    expect(failure).toMatchObject({ name: "OperationFailure", message: "no such character", operation: "list_characters", completion: { outcome: "failed" } });
    const cancelled = new OperationClient(daemon(() => ({ frames: [], finished: "cancelled" })).connection);
    expect(await cancelled.run("list_characters", {}).then(() => "", (error: unknown) => (error as Error).message)).toBe("Action cancelled");
  });

  test("a tool run's pictures get the data the daemon sent alongside it", async () => {
    const picture = (path: string, data?: string) => ({ path, ...(data === undefined ? {} : { data }) });
    const report = (rid: string) => ({
      type: "command_output", rid, name: "run_tool",
      data: {
        tool: "screenshot", character: "ada", kind: "builtin", enabled: true, input: {}, ok: true, rejected: false, duration_ms: 1,
        output: "", truncated: false, result_chars: 0, raw: null, calls: [],
        images: [picture("/sent.png"), picture("/result.png"), picture("/kept.png", "own"), picture("/unknown.png")],
      },
    });
    const client = new OperationClient(daemon((_request, rid) => ({
      frames: [
        { type: "send_image", rid, path: "/sent.png", data: "from-send" },
        { type: "send_image", rid, path: "/no-data.png" },
        { type: "tool_result", rid, tool_name: "screenshot", output: "", is_error: false, images: [picture("/result.png", "from-result"), picture("/sent.png", "late"), picture("/bare.png")] },
        { type: "tool_result", rid, tool_name: "screenshot", output: "", is_error: false },
        report(rid),
      ],
      finished: "completed",
    })).connection);
    const result = await client.run("run_tool", { tool: "screenshot" });
    expect("images" in result ? result.images?.map((image) => [image.path, image.data]) : []).toEqual([
      ["/sent.png", "from-send"], ["/result.png", "from-result"], ["/kept.png", "own"], ["/unknown.png", null],
    ]);
    const other = new OperationClient(daemon((_request, rid) => ({
      frames: [{ type: "send_image", rid, path: "/x.png", data: "ignored" }, { type: "command_output", rid, name: "list_characters", data: characters }],
      finished: "completed",
    })).connection);
    expect(await other.run("list_characters", {}), "only a tool run collects pictures").toEqual(characters);
  });
});

describe("how the settings pages word things", () => {
  test("key=value lines become pairs, keeping everything after the first equals sign", () => {
    expect(parsePairs("a=1\n\n  b = two=2 \n  ")).toEqual({ a: "1", b: " two=2 " });
    expect(() => parsePairs("=nameless")).toThrow("Use key=value on each line: “=nameless”");
    expect(() => parsePairs("  just words  ")).toThrow("Use key=value on each line: “just words”");
    expect(parsePairs("")).toEqual({});
  });

  test("a request's phase reads as what to do about it", () => {
    const request = (phase: WebRequestInfo["phase"], error?: string): WebRequestInfo => ({
      id: "w", rid: "r", operation: "x", label: "X", character: null, thread: null, started_at: 0, expires_at: 0, phase, result_omitted: false,
      ...(error === undefined ? {} : { error: { code: "internal_error", message: error } }),
    });
    expect(requestStatus(request("running"))).toEqual({ text: "Still running", tone: "wait" });
    expect(requestStatus(request("uncertain")).tone).toBe("bad");
    expect(requestStatus(request("uncertain")).text).toContain("Check the affected thread or setting");
    expect(requestStatus(request("completed"))).toEqual({ text: "Completed", tone: "ok" });
    expect(requestStatus(request("failed", "disk full"))).toEqual({ text: "disk full", tone: "bad" });
    expect(requestStatus(request("failed"))).toEqual({ text: "Failed", tone: "bad" });
    expect(requestStatus(request("cancelled"))).toEqual({ text: "Cancelled", tone: "wait" });
    expect(requestStatus(request("superseded"))).toEqual({ text: "Replaced by newer work", tone: "wait" });
  });

  test("an archive's phase reads as where it is and what is next", () => {
    const archive = (phase: WebArchiveInfo["phase"], overrides: Partial<WebArchiveInfo> = {}): WebArchiveInfo =>
      ({ id: "a", filename: "ada.tar", bytes: 1, expires_at: 0, phase, downloadable: false, ...overrides });
    expect(archiveStatus(archive("uploading"))).toEqual({ text: "Uploading…", tone: "wait" });
    expect(archiveStatus(archive("exporting"))).toEqual({ text: "Preparing the export…", tone: "wait" });
    expect(archiveStatus(archive("importing"))).toEqual({ text: "Importing…", tone: "wait" });
    expect(archiveStatus(archive("ready", { downloadable: true }))).toEqual({ text: "Ready to download", tone: "ok" });
    expect(archiveStatus(archive("ready"))).toEqual({ text: "Uploaded, ready to import", tone: "ok" });
    expect(archiveStatus(archive("imported", { result: { name: "import_character", data: { character: "bo" } } as NonNullable<WebArchiveInfo["result"]> }))).toEqual({ text: "Imported bo", tone: "ok" });
    expect(archiveStatus(archive("imported"))).toEqual({ text: "Imported", tone: "ok" });
    expect(archiveStatus(archive("imported", { result: { name: "export_character", data: {} } as NonNullable<WebArchiveInfo["result"]> })).text).toBe("Imported");
    expect(archiveStatus(archive("failed", { error: "too big" }))).toEqual({ text: "too big", tone: "bad" });
    expect(archiveStatus(archive("failed"))).toEqual({ text: "Failed", tone: "bad" });
    expect(archiveStatus(archive("uncertain")).text).toContain("Check the character list");
  });

  test("where a model choice comes from is said in words", () => {
    expect(sourceLabel(null, "ada")).toBeUndefined();
    expect(sourceLabel(undefined, "ada")).toBeUndefined();
    expect(sourceLabel("", "ada")).toBeUndefined();
    expect(sourceLabel("character", "ada")).toBe("Chosen for ada");
    expect(sourceLabel("character", null)).toBe("Chosen for this character");
    expect(sourceLabel("inherits chat (opus)", null)).toBe("Same as chat (opus)");
    expect(sourceLabel("thread story", null)).toBe("Chosen for thread story");
    expect(sourceLabel("first in catalog", null)).toBe("First model in the catalog");
    expect(sourceLabel("subagent", null)).toBe("Chosen for this subagent");
    expect(sourceLabel("thread-default", "ada")).toBe("Uses ada’s default");
    expect(sourceLabel("thread-default", null)).toBe("Uses the character’s default");
    expect(sourceLabel("chat.model", null)).toBe("From the configuration (chat.model)");
    expect(sourceLabel("background.heartbeat.model", null)).toBe("From the configuration (background.heartbeat.model)");
    expect(sourceLabel("chat model", null)).toBe("chat model");
    expect(sourceLabel("x.model.y", null)).toBe("x.model.y");
  });
});
