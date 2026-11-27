import { afterEach, describe, expect, jest, test } from "bun:test";
import { CommandError } from "../src/commands/errors.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { Server } from "../src/swp/server.ts";
import { commandRefusal, eventResponse, operationExists, operationResponse, runRequest } from "../src/web/operations.ts";
import { required } from "../src/util/required.ts";
import { until } from "./support/until.ts";

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
  const seen: { name: string; args: unknown; character: string | null; thread: string | null; limits: unknown }[] = [];
  const disconnects: number[] = [];
  const sending: Promise<void>[] = [];
  let held = 0;
  const routing = (async () => {
    for await (const route of server.routes()) {
      if (route.kind === "session_disconnected") disconnects.push(route.sessionId);
      if (route.kind !== "command") continue;
      const { sessionId, selectedCharacter, selectedThread } = route.meta.session;
      seen.push({ name: route.cmd.name, args: route.cmd.args, character: selectedCharacter, thread: selectedThread, limits: route.meta.session.archiveLimits });
      const rid = route.meta.rid ?? "";
      sending.push((async () => {
        for (const frame of await (behaviours[route.cmd.name] ?? (() => []))(rid, (route.cmd.args ?? {}) as Record<string, unknown>)) {
          await server.sessionRouter.sendToSession(sessionId, frame);
        }
      })());
    }
  })();
  cleanups.push(async () => { server.stop(); await routing; });
  const call = (name: string, init: RequestInit = {}, path = `/api/op/${name}`) => operationResponse(new Request(`http://desk${path}`, { method: "POST", ...init }), {
    server, name, clientName: "test", owner: "owner", queuedBytes: 1024 * 1024, holdOpen: () => { held += 1; },
  });
  const follow = (queuedBytes = 1024 * 1024) => eventResponse(new Request("http://desk/api/events?character=ada"), { server, clientName: "test", owner: "owner", queuedBytes, holdOpen: () => { held += 1; } });
  const sent = async () => { await Promise.all(sending); };
  return { server, seen, disconnects, call, follow, sent, held: () => held };
}

const finished = (rid: string, error?: { code: string; message: string; retry_after_ms?: number }): ServerMessage =>
  ({ type: "request_finished", rid, outcome: error === undefined ? "completed" : "failed", ...(error === undefined ? {} : { error }) }) as ServerMessage;
const output = (rid: string, data: unknown): ServerMessage => ({ type: "command_output", rid, name: "status", data });
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function settled(holds: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000 && !holds(); turn += 1) await Promise.resolve();
  expect(holds()).toBe(true);
}

async function lines(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text()).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("an operation's answer", () => {
  test("only the daemon's operations exist", () => {
    expect([operationExists("status"), operationExists("message"), operationExists("no_such_operation")]).toEqual([true, true, false]);
  });

  test("a command's refusal answers with its code, and any other failure is not a refusal", async () => {
    const answer = commandRefusal(new CommandError("not_found", "No such thing"));
    expect([answer.status, await answer.json()]).toEqual([404, { code: "not_found", message: "No such thing" }]);
    expect(() => commandRefusal(new Error("a bug"))).toThrow("a bug");
  });

  test("a retry hint that is null is left out", async () => {
    const w = world({ status: (rid) => [{ type: "request_finished", rid, outcome: "failed", error: { code: "busy", message: "later", retry_after_ms: null } }] });
    const answered = await w.call("status");
    expect([answered.status, await answered.json()]).toEqual([409, { code: "busy", message: "later" }]);
  });

  test("every operation and every follower keeps its connection open while it waits, even one that is refused", async () => {
    const w = world({ status: (rid) => [finished(rid)] });
    await w.call("status");
    await w.call("switch_thread");
    await w.follow();
    expect(w.held()).toBe(3);
  });

  test("a message or regen needs its fields as a JSON object, and fields that don't make a request are refused before anything runs", async () => {
    const w = world({});
    const refusals: [string, unknown, string][] = [
      ["message", "hello", "Send the message's fields as a JSON object"],
      ["message", ["hello"], "Send the message's fields as a JSON object"],
      ["message", null, "Send the message's fields as a JSON object"],
      ["regen", 5, "Send the regen's fields as a JSON object"],
      ["message", {}, 'Frame is missing required field "text"'],
      ["message", { text: "hi", image_data: "x" }, 'Frame field "image_data" is not an array'],
      ["message", { text: "hi", image_data: [{ filename: "", media_type: "image/png", data: "aGk=" }] }, "Attachment 1 has an empty filename"],
    ];
    for (const [name, args, message] of refusals) {
      const answered = await w.call(name, json(args));
      expect([answered.status, await answered.json()]).toEqual([400, { code: "invalid_request", message }]);
    }
    expect(w.seen).toEqual([]);
  });

  test("another command's output isn't taken for the answer", async () => {
    const w = world({ status: (rid) => [{ type: "command_output", rid, name: "other", data: 1 }, finished(rid)] });
    const answered = await w.call("status");
    expect(await answered.json()).toEqual({ type: "request_finished", rid: answered.headers.get("shore-request"), outcome: "completed" });
  });

  test("a request isn't held up by what the daemon tells everyone else meanwhile", async () => {
    let release = (): void => {};
    const w = world({ status: async (rid) => { await new Promise<void>((resolve) => { release = resolve; }); return [output(rid, "done"), finished(rid)]; } });
    const answering = w.call("status");
    await until(() => w.seen.length === 1, "the request to reach the daemon");
    for (let sent = 0; sent < 300; sent += 1) w.server.broadcast({ type: "cache_warning", message: "x".repeat(1500), expected_tokens: sent });
    release();
    const answered = await answering;
    expect([answered.status, await answered.json()]).toEqual([200, "done"]);
  });

  test("a streamed answer nobody reads yet keeps its text in one piece instead of outgrowing the daemon's hold", async () => {
    const w = world({ status: (rid) => [...Array.from({ length: 300 }, (): ServerMessage => ({ type: "stream_chunk", rid, text: "ab", content_type: "text" })), finished(rid)] });
    const streamed = await w.call("status", { headers: { accept: "application/x-ndjson" } });
    await until(() => w.seen.length === 1, "the request to reach the daemon");
    await w.sent();
    const frames = await lines(streamed);
    expect(frames.filter((frame) => frame["type"] === "stream_chunk").map((frame) => frame["text"]).join("")).toBe("ab".repeat(300));
    expect(frames.at(-1)?.["type"]).toBe("request_finished");
  });

  test("an answer that outgrows what the daemon holds for a slow reader ends by saying so", async () => {
    const w = world({ status: (rid) => [...Array.from({ length: 300 }, (_, at): ServerMessage => ({ type: "command_output", rid, name: "status", data: at })), finished(rid)] });
    const streamed = await w.call("status", { headers: { accept: "application/x-ndjson" } });
    await until(() => w.seen.length === 1, "the request to reach the daemon");
    await w.sent();
    expect((await lines(streamed)).at(-1)).toEqual({ type: "error", code: "internal_error", message: "The answer outgrew what the daemon holds for a slow reader" });
  });

  test("a request carries the archive limits it is given, and none when it is given none", async () => {
    const w = world({ status: (rid) => [finished(rid)] });
    const ask = async (archiveLimits?: { bytes: number; entries: number }) => {
      for await (const frame of runRequest(w.server, { message: { type: "command", name: "status", args: {}, rid: "r" }, clientName: "test", signal: new AbortController().signal, queuedBytes: 1024 * 1024, ...(archiveLimits === undefined ? {} : { archiveLimits }) })) if (frame.type === "request_finished") break;
    };
    await ask({ bytes: 5, entries: 2 });
    await ask();
    expect(w.seen.map((entry) => entry.limits)).toEqual([{ bytes: 5, entries: 2 }, undefined]);
  });

  test("a client that stops reading a streamed answer lets go of the request at once, and its pings stop", async () => {
    const w = world({ status: () => new Promise<ServerMessage[]>(() => {}) });
    jest.useFakeTimers();
    cleanups.push(() => { jest.useRealTimers(); });
    const streamed = await w.call("status", { headers: { accept: "application/x-ndjson" } });
    const reader = streamed.body?.getReader();
    const reading = reader?.read();
    await settled(() => w.seen.length === 1);
    await reader?.cancel();
    await reading;
    jest.advanceTimersByTime(90_000);
    jest.useRealTimers();
    await until(() => w.disconnects.length === 1, "the request to let go");
  });

  test("a streamed answer that is over sends no more pings", async () => {
    const w = world({ status: (rid) => [output(rid, 1), finished(rid)] });
    jest.useFakeTimers();
    cleanups.push(() => { jest.useRealTimers(); });
    const streamed = await w.call("status", { headers: { accept: "application/x-ndjson" } });
    expect((await lines(streamed)).map((frame) => frame["type"])).toEqual(["command_output", "request_finished"]);
    jest.advanceTimersByTime(90_000);
  });
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
    const pinged = reader?.read();
    await settled(() => w.seen.length === 1);
    jest.advanceTimersByTime(29_999);
    jest.advanceTimersByTime(1);
    expect((await pinged)?.value).toBe('{"type":"ping"}\n');
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
    const { message } = await answered.clone().json() as { message: string };
    expect([answered.status, await answered.json()]).toEqual([500, { code: "internal_error", message }]);
    expect(message).not.toStartWith("Error");
    const streamed = await lines(await w.call("status", { headers: { accept: "application/x-ndjson" } }));
    expect(streamed).toEqual([{ type: "error", code: "internal_error", message }]);
  });
});

describe("following events", () => {
  test("a follower hears that the daemon is alive every thirty seconds", async () => {
    const w = world({});
    jest.useFakeTimers();
    cleanups.push(() => { jest.useRealTimers(); });
    const reader = (await w.follow()).body?.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader?.read())?.value).toBe('{"type":"ping"}\n');
    jest.advanceTimersByTime(30_000);
    expect((await reader?.read())?.value).toBe('{"type":"ping"}\n');
    await reader?.cancel();
  });

  test("a follower that stops reading lets go of the daemon at once, and its pings stop", async () => {
    const w = world({});
    jest.useFakeTimers();
    cleanups.push(() => { jest.useRealTimers(); });
    const reader = (await w.follow()).body?.getReader();
    await reader?.read();
    await reader?.cancel();
    jest.advanceTimersByTime(90_000);
    jest.useRealTimers();
    await until(() => w.disconnects.length === 1, "the follower to let go");
  });

  test("a follower hears the daemon stop, and nothing after it", async () => {
    const w = world({});
    jest.useFakeTimers();
    cleanups.push(() => { jest.useRealTimers(); });
    const response = await w.follow();
    w.server.stop();
    expect(await lines(response)).toEqual([{ type: "ping" }, { type: "shutdown" }]);
    jest.advanceTimersByTime(90_000);
  });

  test("a follower that is behind on a stream gets its text in one piece instead of being told to follow again", async () => {
    const w = world({});
    const response = await w.follow();
    const [follower] = required(w.server.sessionRouter.sessions()[0]);
    for (let sent = 0; sent < 300; sent += 1) await w.server.sessionRouter.sendToSession(follower, { type: "stream_chunk", rid: "r", text: "ab", content_type: "text" });
    const reader = required(response.body).pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    const told = () => text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    const streamed = () => told().filter((frame) => frame["type"] === "stream_chunk").map((frame) => frame["text"]).join("");
    while (streamed().length < 600) {
      const next = await reader.read();
      if (next.done) throw new Error(`the follower was cut off: ${text}`);
      text += next.value;
    }
    expect([streamed(), told().filter((frame) => frame["type"] === "error")]).toEqual(["ab".repeat(300), []]);
    await reader.cancel();
  });
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
