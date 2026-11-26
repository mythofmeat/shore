import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { Server } from "../src/swp/server.ts";
import { eventResponse, operationResponse } from "../src/web/operations.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Behaviour = (rid: string, args: Record<string, unknown>) => ServerMessage[] | Promise<ServerMessage[]>;

function world(behaviours: Record<string, Behaviour>) {
  const server = new Server({
    handshake: {
      hello: () => Promise.resolve({ characters: [{ name: "ada" }] }),
      select: (character, thread) => Promise.resolve({ character, thread }),
      history: () => Promise.reject(new Error("a request never needs history")),
    },
  });
  const seen: { name: string; args: unknown; character: string | null; thread: string | null }[] = [];
  const routing = (async () => {
    for await (const route of server.routes()) {
      if (route.kind !== "command") continue;
      const { sessionId, selectedCharacter, selectedThread } = route.meta.session;
      seen.push({ name: route.cmd.name, args: route.cmd.args, character: selectedCharacter, thread: selectedThread });
      const rid = route.meta.rid ?? "";
      void (async () => {
        for (const frame of await (behaviours[route.cmd.name] ?? (() => []))(rid, (route.cmd.args ?? {}) as Record<string, unknown>)) {
          await server.sessionRouter.sendToSession(sessionId, frame);
        }
      })();
    }
  })();
  cleanups.push(async () => { server.stop(); await routing; });
  const call = (name: string, init: RequestInit = {}, path = `/api/op/${name}`) => operationResponse(new Request(`http://desk${path}`, { method: "POST", ...init }), {
    server, name, clientName: "test", owner: "owner", queuedBytes: 1024 * 1024, holdOpen: () => {},
  });
  return { server, seen, call };
}

const finished = (rid: string, error?: { code: string; message: string; retry_after_ms?: number }): ServerMessage =>
  ({ type: "request_finished", rid, outcome: error === undefined ? "completed" : "failed", ...(error === undefined ? {} : { error }) }) as ServerMessage;
const output = (rid: string, data: unknown): ServerMessage => ({ type: "command_output", rid, name: "status", data });
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function lines(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text()).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("an operation's answer", () => {
  test("each error code comes back under its own HTTP status, with a retry hint only when there is one", async () => {
    const w = world({ status: (rid, args) => [finished(rid, { code: String(args["code"]), message: "it went wrong", ...(args["retry"] === true ? { retry_after_ms: 9 } : {}) })] });
    const statuses: [string, number][] = [["invalid_request", 400], ["protocol_error", 400], ["unauthorized", 401], ["not_found", 404], ["busy", 409], ["internal_error", 500], ["provider_error", 502], ["timeout", 504]];
    for (const [code, status] of statuses) {
      const answered = await w.call("status", json({ code }));
      expect([answered.status, await answered.json()]).toEqual([status, { code, message: "it went wrong" }]);
    }
    const hinted = await w.call("status", json({ code: "provider_error", retry: true }));
    expect(await hinted.json()).toEqual({ code: "provider_error", message: "it went wrong", retry_after_ms: 9 });
  });

  test("a command's error frame stands for it when the finish carries none, and the output is the answer when there is one", async () => {
    const w = world({
      status: (rid, args) => args["fail"] === true
        ? [{ type: "error", rid, code: "busy", message: "from the frame" }, { type: "request_finished", rid, outcome: "failed" }]
        : [output(rid, { fine: true }), finished(rid)],
    });
    const failed = await w.call("status", json({ fail: true }));
    expect([failed.status, await failed.json()]).toEqual([409, { code: "busy", message: "from the frame" }]);
    const answered = await w.call("status", json({}));
    expect([answered.status, await answered.json(), answered.headers.get("cache-control")]).toEqual([200, { fine: true }, "no-store"]);
  });

  test("a request with no body runs with no arguments, and one that isn't JSON is refused before it runs", async () => {
    const w = world({ status: (rid) => [output(rid, null), finished(rid)] });
    expect((await w.call("status")).status).toBe(200);
    expect(w.seen.map((entry) => entry.args)).toEqual([{}]);
    const notJson = await w.call("status", { body: "x", headers: { "content-type": "text/plain" } });
    expect([notJson.status, await notJson.json()]).toEqual([400, { code: "invalid_request", message: "Send the operation's arguments as a JSON object" }]);
    const tooBig = await w.call("status", { body: "x", headers: { "content-type": "application/json", "content-length": String(64 * 1024 * 1024) } });
    expect([tooBig.status, ((await tooBig.json()) as { message: string }).message]).toEqual([400, "Request body is too large"]);
    expect(w.seen).toHaveLength(1);
  });

  test("streams frame by frame when the client accepts it among other types, and names the character and thread from the query", async () => {
    const w = world({ status: (rid) => [{ type: "request_accepted", rid }, output(rid, 1), finished(rid)] });
    const streamed = await w.call("status", { headers: { accept: "text/html, application/x-ndjson;q=0.9" } }, "/api/op/status?character=ada&thread=garden&other=1");
    expect(streamed.headers.get("content-type")).toBe("application/x-ndjson");
    const rid = streamed.headers.get("shore-request");
    expect((await lines(streamed)).map((frame) => [frame["type"], frame["rid"]])).toEqual([["request_accepted", rid], ["command_output", rid], ["request_finished", rid]]);
    expect(w.seen.at(-1)).toMatchObject({ character: "ada", thread: "garden" });
    const plain = await w.call("status", { headers: { accept: "application/json" } }, "/api/op/status?character=&thread=");
    expect(plain.headers.get("content-type")).toStartWith("application/json");
    expect(w.seen.at(-1)).toMatchObject({ character: "ada", thread: null });
  });

  test("a stream waiting on a slow request says it is alive every thirty seconds", async () => {
    let release = (): void => {};
    const w = world({ status: async (rid) => { await new Promise<void>((resolve) => { release = resolve; }); return [output(rid, 1), finished(rid)]; } });
    jest.useFakeTimers();
    cleanups.push(() => { jest.useRealTimers(); });
    const streamed = await w.call("status", { headers: { accept: "application/x-ndjson" } });
    const reader = streamed.body?.pipeThrough(new TextDecoderStream()).getReader();
    jest.advanceTimersByTime(29_999);
    jest.advanceTimersByTime(1);
    expect((await reader?.read())?.value).toBe('{"type":"ping"}\n');
    release();
    jest.useRealTimers();
    let text = "";
    for (let next = await reader?.read(); next !== undefined && !next.done; next = await reader?.read()) text += next.value;
    expect(text).toContain('"type":"request_finished"');
  });

  test("a request the daemon can't take any more fails as itself, whether streamed or not", async () => {
    const w = world({});
    w.server.stop();
    const answered = await w.call("status");
    expect([answered.status, ((await answered.json()) as { code: string }).code]).toEqual([500, "internal_error"]);
    const streamed = await lines(await w.call("status", { headers: { accept: "application/x-ndjson" } }));
    expect(streamed.map((frame) => [frame["type"], frame["code"]])).toEqual([["error", "internal_error"]]);
  });
});

describe("following events", () => {
  test("a reader that falls behind is told to follow again instead of missing events quietly", async () => {
    const w = world({});
    const response = await eventResponse(new Request("http://desk/api/events?character=ada"), { server: w.server, clientName: "test", owner: "owner", queuedBytes: 2048, holdOpen: () => {} });
    for (let sent = 0; sent < 4; sent += 1) w.server.broadcast({ type: "cache_warning", message: "x".repeat(1500), expected_tokens: sent });
    const told = await lines(response);
    expect(told[0]).toEqual({ type: "ping" });
    expect(told.at(-1)).toEqual({ type: "error", code: "busy", message: "This reader fell behind the daemon's events; follow again" });
  });

  test("a daemon that is stopping takes no new followers", async () => {
    const w = world({});
    w.server.stop();
    const response = await eventResponse(new Request("http://desk/api/events"), { server: w.server, clientName: "test", owner: "owner", queuedBytes: 2048, holdOpen: () => {} });
    expect([response.status, await response.json()]).toEqual([409, { code: "busy", message: "The daemon is stopping" }]);
  });
});
