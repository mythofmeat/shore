import { afterEach, describe, expect, test } from "bun:test";

import type { ClientMessage } from "../src/protocol/ClientMessage.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { HistorySnapshot } from "../src/swp/handshake.ts";
import { Server, type LocalClientOptions, type LocalPeer } from "../src/swp/server.ts";
import type { RoutedMessage } from "../src/swp/session.ts";
import { rejectionOf } from "./support/outcome.ts";
import { until } from "./support/until.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const snapshot = (character: string | null, thread: string | null | undefined, config: unknown = "fresh"): HistorySnapshot =>
  ({ messages: [], previousSegment: null, config, selectedCharacter: character, selectedThread: thread ?? "main", revision: 0 });

const full = (config: string): ServerMessage => ({ type: "history", messages: [], config, selected_character: "ada", selected_thread: "main", revision: 1 });
const chunk = (text: string): ServerMessage => ({ type: "stream_chunk", rid: "r", text, content_type: "text", subagent: null, task_id: null });

interface World {
  readonly server: Server;
  readonly routed: RoutedMessage[];
  readonly logged: string[];
  readonly fetched: (readonly [string | null, string | null | undefined])[];
  readonly selected: (readonly [string | null, string | null])[];
  hold(): () => void;
  attach(options?: Partial<LocalClientOptions>): Promise<LocalPeer>;
  kinds(sessionId: number): string[];
}

async function world(history: (character: string | null, thread?: string | null) => Promise<HistorySnapshot> = (character, thread) => Promise.resolve(snapshot(character, thread))): Promise<World> {
  const logged: string[] = [];
  const fetched: (readonly [string | null, string | null | undefined])[] = [];
  const selected: (readonly [string | null, string | null])[] = [];
  let held: Promise<void> | undefined;
  const server = new Server({
    log: { info: (message) => logged.push(message), warn: (message) => logged.push(message), error: (message) => logged.push(message) },
    handshake: {
      hello: () => Promise.resolve({ characters: [{ name: "ada" }, { name: "bo" }] }),
      select: (character, thread) => { selected.push([character, thread]); return Promise.resolve({ character, thread: thread === null ? null : `${thread}-resolved` }); },
      history: async (character, thread) => {
        fetched.push([character, thread]);
        if (held !== undefined) await held;
        return await history(character, thread);
      },
    },
  });
  const routed: RoutedMessage[] = [];
  const routing = (async () => { for await (const message of server.routes()) routed.push(message); })();
  cleanups.push(async () => { server.stop(); await routing; });
  return {
    server, routed, logged, fetched, selected,
    hold: () => {
      let release = (): void => {};
      held = new Promise<void>((resolve) => { release = resolve; });
      return () => { held = undefined; release(); };
    },
    attach: (options = {}) => server.attachLocal({ clientType: "web", clientName: "tab", character: "ada", thread: "main", ...options }),
    kinds: (sessionId) => routed.flatMap((message) => "sessionId" in message && message.sessionId === sessionId ? [message.kind] : []),
  };
}

async function take(peer: LocalPeer, count: number): Promise<ServerMessage[]> {
  const out: ServerMessage[] = [];
  if (count === 0) return out;
  for await (const message of peer.events()) {
    out.push(message);
    if (out.length === count) break;
  }
  return out;
}

async function ended(peer: LocalPeer): Promise<boolean> {
  const next = peer.events().next();
  return await Promise.race([next.then((result) => result.done === true), Bun.sleep(200).then(() => false)]);
}

function overflows(): { count: number; readonly onOverflow: () => void } {
  const seen = { count: 0, onOverflow: () => { seen.count += 1; } };
  return seen;
}

describe("a local peer attaching", () => {
  test("gets back its session as asked for, is announced, and hears its history first", async () => {
    const w = await world();
    const archiveLimits = { bytes: 10, entries: 2, temporaryDirectory: "/nowhere" };
    const kept = await w.attach({ owner: "laptop", archiveLimits });
    const plain = await w.attach({ character: "bo" });
    expect(kept.session).toMatchObject({ owner: "laptop", archiveLimits, selectedCharacter: "ada", selectedThread: "main" });
    expect("owner" in plain.session).toBe(false);
    expect("archiveLimits" in plain.session).toBe(false);
    expect(await take(kept, 1)).toEqual([{ type: "history", messages: [], config: "fresh", selected_thread: "main", selected_character: "ada", revision: 0 }]);
    await until(() => w.kinds(kept.session.sessionId).includes("session_connected"), "the peer to be announced");
    expect(w.kinds(plain.session.sessionId)).toEqual(["session_connected"]);
  });

  test("for one request, skips the history snapshot and every broadcast, and hears only what is sent to its session", async () => {
    const w = await world();
    const peer = await w.attach({ history: false, broadcasts: false, character: "bo", thread: "garden" });
    expect(w.fetched).toEqual([]);
    expect(w.selected).toEqual([["bo", "garden"]]);
    expect(peer.history).toBeUndefined();
    expect(peer.session).toMatchObject({ selectedCharacter: "bo", selectedThread: "garden-resolved" });
    w.server.broadcast({ type: "ping" });
    await Bun.sleep(20);
    await w.server.sessionRouter.sendToSession(peer.session.sessionId, chunk("only you"));
    expect(await take(peer, 1)).toEqual([chunk("only you")]);
    await peer.detach();
    const characterless = await w.attach({ history: false, character: null });
    expect(w.selected.at(-1)).toEqual([null, "main"]);
    expect(characterless.session.selectedCharacter).toBeNull();
  });

  test("with live limits, needs a positive whole number of messages and bytes", async () => {
    const w = await world();
    const seen = overflows();
    for (const [messages, bytes] of [[0, 1], [1.5, 1], [1, 0], [1, 1.5], [Infinity, 1], [1, Infinity]] as const) {
      expect(await rejectionOf(w.attach({ outboundLimits: { messages, bytes, onOverflow: seen.onOverflow } })))
        .toMatchObject({ message: "Local outbound limits must be positive safe integers" });
    }
    expect((await w.attach({ outboundLimits: { messages: 1, bytes: 1, onOverflow: seen.onOverflow } })).session.selectedCharacter).toBe("ada");
    expect(seen.count).toBe(0);
  });

  test("is refused once the server is stopping, and leaves nothing behind however late it is called off", async () => {
    const stopped = await world();
    stopped.server.stop();
    expect(await rejectionOf(stopped.attach())).toMatchObject({ name: "AbortError" });
    for (let ticks = 0; ticks < 16; ticks += 1) {
      const controller = new AbortController();
      const w = await world(async (character, thread) => {
        let left = ticks;
        const tick = (): void => { if (left-- === 0) controller.abort(); else queueMicrotask(tick); };
        queueMicrotask(tick);
        return snapshot(character, thread);
      });
      const attached = await w.attach({ signal: controller.signal }).catch(() => undefined);
      await until(() => w.server.sessionRouter.sessions().length === 0, `the peer called off after ${String(ticks)} ticks to be gone`, 1000);
      if (attached !== undefined) await until(() => w.kinds(attached.session.sessionId).at(-1) === "session_disconnected", "the peer to be announced gone");
    }
  });

  test("called off while its history is being prepared, is never announced and hears nothing", async () => {
    const w = await world();
    const controller = new AbortController();
    const seen = overflows();
    const peer = await w.attach({
      signal: controller.signal, outboundLimits: { messages: 1, bytes: 1, onOverflow: seen.onOverflow },
      prepareMessage: (message) => { controller.abort(); return message; },
    });
    await until(() => w.kinds(peer.session.sessionId).includes("session_disconnected"), "the peer to be announced gone");
    expect(w.kinds(peer.session.sessionId)).toEqual(["session_disconnected"]);
    expect(await ended(peer)).toBe(true);
    expect(seen.count).toBe(0);
  });
});

describe("what a local peer is sent", () => {
  test("what catches it up never counts against its limits, and live traffic past them cuts it off for good", async () => {
    const w = await world((character, thread) => Promise.resolve(snapshot(character, thread, "x".repeat(10_000))));
    const seen = overflows();
    const peer = await w.attach({ outboundLimits: { messages: 1, bytes: 128, onOverflow: seen.onOverflow } });
    const send = w.server.sessionRouter.senderFor(peer.session.sessionId);
    if (send === undefined) throw new Error("the peer has no sender");
    const caughtUp = Array.from({ length: 50 }, (_, i) => chunk(String(i)));
    for (const frame of caughtUp) await send(frame, true);
    await send(chunk("live"));
    const heard = await take(peer, 52);
    expect(heard.slice(1)).toEqual([...caughtUp, chunk("live")]);
    expect(seen.count).toBe(0);

    await send(chunk("one"));
    await send(chunk("two"));
    expect(seen.count).toBe(1);
    await until(() => w.kinds(peer.session.sessionId).includes("session_disconnected"), "the peer to be cut off");
    expect(await ended(peer)).toBe(true);
    for (let i = 0; i < 5; i += 1) await send(chunk("after"));
    expect(seen.count).toBe(1);
  });

  test("a broadcast reaches it when it is about its character and thread, and a full history comes through as it was sent", async () => {
    const w = await world();
    const ada = await w.attach();
    const bo = await w.attach({ character: "bo" });
    await take(ada, 1);
    await take(bo, 1);
    const nullDelta: ServerMessage = { type: "history", messages: [], config: "sent", selected_character: "ada", selected_thread: "main", revision: 2, delta: null };
    const absent: ServerMessage = { type: "history", messages: [], config: "also sent", selected_character: "ada", selected_thread: "main", revision: 3 };
    w.server.broadcast({ type: "history", messages: [], config: "elsewhere", selected_character: "ada", selected_thread: "side", revision: 1 });
    w.server.broadcast(nullDelta);
    w.server.broadcast(absent);
    w.server.broadcast({ type: "history", messages: [], config: "for bo", selected_character: "bo", selected_thread: "main", revision: 1 });
    expect(await take(ada, 2)).toEqual([nullDelta, absent]);
    expect((await take(bo, 1))[0]).toMatchObject({ config: "for bo" });
  });

  test("a peer that can't apply a history delta gets the whole history instead, and one that can gets the delta", async () => {
    const w = await world();
    const whole = await w.attach();
    const deltas = await w.attach({ capabilities: ["history-deltas"] });
    await take(whole, 1);
    await take(deltas, 1);
    const delta: ServerMessage = { type: "history", messages: [], config: "delta", selected_character: "ada", selected_thread: "main", revision: 4, delta: { base_revision: 3, after: null } };
    w.server.broadcast(delta);
    expect(await take(deltas, 1)).toEqual([delta]);
    expect(await take(whole, 1)).toEqual([{ type: "history", messages: [], config: "fresh", selected_thread: "main", selected_character: "ada", revision: 0 }]);
    expect(w.fetched.at(-1)).toEqual(["ada", "main"]);
  });

  test("a peer that falls behind on broadcasts is told how far, and cut off only if it has limits", async () => {
    const w = await world();
    const lags: number[] = [];
    const seen = overflows();
    const bounded = await w.attach({ onLag: (skipped) => lags.push(skipped), outboundLimits: { messages: 4, bytes: 1_000_000, onOverflow: seen.onOverflow } });
    const open = await w.attach({ onLag: (skipped) => lags.push(-skipped) });
    await take(bounded, 1);
    await take(open, 1);
    const release = w.hold();
    w.server.broadcast({ type: "history", messages: [], config: "delta", selected_character: "ada", selected_thread: "main", revision: 1, delta: { base_revision: 0, after: null } });
    await until(() => w.fetched.length === 4, "both peers to be fetching a whole history");
    for (let i = 0; i < 300; i += 1) w.server.broadcast(full(String(i)));
    release();
    await until(() => lags.length === 2, "both peers to hear they fell behind");
    expect(lags.filter((skipped) => skipped > 0)).toEqual([296]);
    expect(lags.filter((skipped) => skipped < 0)).toEqual([-44]);
    expect(seen.count).toBe(1);
    await until(() => w.kinds(bounded.session.sessionId).includes("session_disconnected"), "the bounded peer to be cut off");
    w.server.broadcast(full("still here"));
    expect((await take(open, 258)).at(-1)).toEqual(full("still here"));
    expect(w.kinds(open.session.sessionId)).toEqual(["session_connected"]);
  });

  test("a relay that fails is logged and the peer is let go", async () => {
    let fail = false;
    const w = await world((character, thread) => fail ? Promise.reject(new Error("history is gone")) : Promise.resolve(snapshot(character, thread)));
    const peer = await w.attach();
    await take(peer, 1);
    fail = true;
    w.server.broadcast({ type: "history", messages: [], config: "delta", selected_character: "ada", selected_thread: "main", revision: 1, delta: { base_revision: 0, after: null } });
    await until(() => w.kinds(peer.session.sessionId).includes("session_disconnected"), "the peer to be let go");
    expect(w.logged).toContain("Local client event relay failed");
  });
});

describe("a local peer leaving", () => {
  test("is announced gone once however often it detaches, drops what it hadn't read, and takes no more requests", async () => {
    const w = await world();
    let prepared = 0;
    const peer = await w.attach({ prepareMessage: (message) => { prepared += 1; return message; } });
    const send = w.server.sessionRouter.senderFor(peer.session.sessionId);
    if (send === undefined) throw new Error("the peer has no sender");
    await send(chunk("unread"));
    await Promise.all([peer.detach(), peer.detach()]);
    await peer.detach();
    expect(await ended(peer)).toBe(true);
    await send(chunk("too late"));
    expect(prepared).toBe(2);
    await until(() => w.kinds(peer.session.sessionId).length === 2, "the peer to be announced gone");
    expect(w.kinds(peer.session.sessionId)).toEqual(["session_connected", "session_disconnected"]);
    expect(await rejectionOf(peer.send({ type: "cancel" }))).toMatchObject({ message: "Local peer is detached" });
  });

  test("hears nothing more once it has gone, however much is broadcast", async () => {
    const w = await world();
    const lags: number[] = [];
    const seen = overflows();
    const peer = await w.attach({ onLag: (skipped) => lags.push(skipped), outboundLimits: { messages: 2, bytes: 1_000_000, onOverflow: seen.onOverflow } });
    await peer.detach();
    for (let i = 0; i < 10; i += 1) w.server.broadcast(full(String(i)));
    await Bun.sleep(10);
    expect(lags).toEqual([]);
    expect(seen.count).toBe(0);
  });

  test("goes when its caller calls it off", async () => {
    const w = await world();
    const controller = new AbortController();
    const peer = await w.attach({ signal: controller.signal });
    controller.abort();
    await until(() => w.kinds(peer.session.sessionId).includes("session_disconnected"), "the peer to go");
    expect(await ended(peer)).toBe(true);
    expect(w.server.sessionRouter.has(peer.session.sessionId)).toBe(false);
  });

  test("goes when the server stops, before the server says it has stopped", async () => {
    const w = await world();
    const peer = await w.attach();
    w.server.stop();
    await until(() => w.kinds(peer.session.sessionId).includes("session_disconnected"), "the peer to go with the server");
    expect(await ended(peer)).toBe(true);
  });
});

describe("what a local peer asks", () => {
  test("is answered at once when it can be, checked before it is routed, and routed after its caller's last word", async () => {
    const w = await world();
    const peer = await w.attach();
    await take(peer, 1);
    await peer.send({ type: "hello", client_type: "web", client_name: "again", capabilities: [] });
    await peer.send({ type: "nope" } as unknown as ClientMessage);
    const answers = await take(peer, 2);
    expect(answers[0]).toEqual({ type: "error", code: "protocol_error", message: "Duplicate hello" });
    expect(answers[1]).toMatchObject({ type: "error", code: "invalid_request" });

    const broken = { get type(): string { throw new Error("broken request"); } } as unknown as ClientMessage;
    expect(await rejectionOf(peer.send(broken))).toMatchObject({ message: "broken request" });

    const order: string[] = [];
    await peer.send({ type: "cancel" }, () => { order.push(`before, ${String(w.routed.filter((m) => m.kind === "engine").length)} routed`); });
    await until(() => w.routed.some((m) => m.kind === "engine"), "the cancel to be routed");
    expect(order).toEqual(["before, 0 routed"]);
  });
});
