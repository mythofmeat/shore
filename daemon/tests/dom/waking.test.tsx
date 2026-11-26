import { afterEach, expect, setSystemTime, test } from "bun:test";

import { useApp, HOLD } from "./app.ts";
import { FakeSocket, LISTING, catalogue, daemonRequests, HELLO, replace } from "./daemon.ts";
import { acting, mount } from "./dom.ts";
import type { WebRequestInfo } from "../../src/protocol/WebRequestInfo.ts";

const app = useApp();
const settle = async (ms = 5) => { await acting(() => Bun.sleep(ms)); };
const MESSAGE = { msg_id: "m1", role: "assistant", content: "hi", content_blocks: [], timestamp: "2026-11-25T10:00:00Z", images: [] };
const answering = (request: Record<string, unknown>): unknown => {
  if (request["name"] === "list_threads") return { ...LISTING, threads: [{ ...LISTING.threads[0], unread: 1 }] };
  if (request["name"] === "presence") return { statuses: [], history: [] };
  const known = catalogue(request);
  if (known !== undefined) return known;
  throw new Error(`no answer for ${String(request["name"])}`);
};

afterEach(() => {
  daemonRequests.splice(0);
  setSystemTime();
});

async function opened(before: number): Promise<FakeSocket> {
  for (let index = 0; index < 100 && FakeSocket.opened.length === before; index += 1) await settle(10);
  const socket = FakeSocket.opened.at(-1);
  if (socket === undefined || FakeSocket.opened.length === before) throw new Error(`no new socket; ${app.state().workspace.connection.detail}`);
  socket.answer = answering;
  await acting(() => {
    socket.fire("open");
    socket.receive(HELLO);
    socket.receive({ type: "history", messages: [MESSAGE], config: {}, revision: 1, selected_character: "ada", selected_thread: "story" });
  });
  await settle(30);
  return socket;
}

async function page() {
  const { App } = await import("../../src/browser/app/App.tsx");
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  for (const shown of toasts.getSnapshot()) toasts.dismiss(shown.id);
  app.socket().answer = answering;
  const sockets = FakeSocket.opened.length;
  const view = await mount(<App />);
  await settle(30);
  const socket = FakeSocket.opened.length === sockets ? app.socket() : await opened(sockets);
  return {
    view, socket,
    cards: () => view.host.querySelectorAll(".notice-card").length,
    notices: () => [...view.host.querySelectorAll(".notice-card > span")].map((notice) => notice.textContent),
    errors: () => toasts.getSnapshot().filter((toast) => toast.tone === "error").map((toast) => toast.text),
  };
}

async function sleepAndWake(socket: FakeSocket, wake: number): Promise<FakeSocket> {
  socket.answer = () => HOLD;
  const asleep = socket.sent.length;
  const sockets = FakeSocket.opened.length;
  setSystemTime(new Date(Date.now() + 10 * 60_000));
  await acting(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(socket.sent.slice(asleep), `wake ${String(wake)}`).toEqual([]);
  await acting(() => { socket.fire("close", { code: 1006, reason: "" }); });
  const next = await opened(sockets);
  expect(next.sent.some((request) => request["name"] === "presence"), "the status is asked for again once connected").toBe(true);
  return next;
}

test("waking from sleep sends nothing into the socket that died in the night, and leaves no notice or error behind", async () => {
  const shown = await page();
  let socket = shown.socket;
  for (let wake = 0; wake < 3; wake += 1) socket = await sleepAndWake(socket, wake);
  expect([shown.cards(), shown.errors()]).toEqual([0, []]);
});

test("Stop pressed right after a sleep sends nothing into the dead socket, says the reply wasn't stopped, and works once reconnected", async () => {
  const shown = await page();
  const { socket } = shown;
  const stop = () => shown.view.host.querySelector<HTMLButtonElement>("button.stop");
  await acting(() => { socket.receive({ type: "stream_start", rid: "r_reply", regen: false }); });
  expect(stop(), "a reply is being written").not.toBeNull();
  const asleep = socket.sent.length;
  const sockets = FakeSocket.opened.length;
  setSystemTime(new Date(Date.now() + 10 * 60_000));
  await acting(() => { stop()?.click(); });
  expect(socket.sent.slice(asleep)).toEqual([]);
  expect(shown.errors()).toEqual(["Shore was reconnecting, so the reply wasn't stopped. Try again in a moment."]);
  const next = await opened(sockets);
  await acting(() => { next.receive({ type: "stream_start", rid: "r_reply", regen: false }); });
  await acting(() => { stop()?.click(); });
  expect(next.sent.at(-1)).toEqual({ type: "cancel" });
});

const record = (id: string, rid: string, phase: WebRequestInfo["phase"]): WebRequestInfo => ({ id, rid, operation: "mark_thread_read", label: "Mark thread read", character: "ada", thread: "story", started_at: Date.now(), expires_at: Date.now() + 60_000, phase, result_omitted: false });

test("a connection that drops with requests in flight shows a notice only for what the daemon still runs or lost track of", async () => {
  const shown = await page();
  const { socket } = shown;
  socket.answer = () => HOLD;
  const { workspace } = app.state();
  const asked = socket.sent.length;
  const sockets = FakeSocket.opened.length;
  const reading = workspace.actions.run("list_threads", {}).catch(() => "interrupted");
  const writing = workspace.actions.run("mark_thread_read", { name: "story" }).catch(() => "interrupted");
  const losing = workspace.actions.run("mark_thread_read", { name: "side" }).catch(() => "interrupted");
  const [writingRid, losingRid] = socket.sent.slice(asked).filter((request) => request["name"] === "mark_thread_read").map((request) => request["rid"]);
  if (typeof writingRid !== "string" || typeof losingRid !== "string") throw new Error("mark_thread_read was not sent");
  daemonRequests.push(record("w", writingRid, "running"), record("l", losingRid, "uncertain"));
  await acting(() => { socket.fire("close", { code: 1006, reason: "" }); });
  expect([await reading, await writing, await losing]).toEqual(["interrupted", "interrupted", "interrupted"]);
  expect(shown.cards(), "nothing is claimed before the daemon is asked").toBe(0);
  const next = await opened(sockets);
  expect(shown.notices()).toEqual(["The connection dropped while a request was in flight. Shore keeps working on it, and this notice clears when it finishes.", "Shore lost track of a request that was in flight, so it can't tell whether it finished. Review it to check what happened."]);
  await acting(() => { next.receive({ type: "request_finished", rid: writingRid, outcome: "completed" }); });
  expect(shown.notices()).toEqual(["Shore lost track of a request that was in flight, so it can't tell whether it finished. Review it to check what happened."]);
});

test("with Recent requests open across a drop, what it lists counts as seen, even when it hears back before the notices are settled", async () => {
  const shown = await page();
  const { socket } = shown;
  const { workspace } = app.state();
  const { navigate } = await import("../../src/browser/app/route.ts");
  await acting(() => { navigate({ view: "settings", page: "diagnostics" }); });
  await settle(30);
  socket.answer = () => HOLD;
  const asked = socket.sent.length;
  const sockets = FakeSocket.opened.length;
  void workspace.actions.run("mark_thread_read", { name: "story" }).catch(() => "interrupted");
  const rid = socket.sent.slice(asked).find((request) => request["name"] === "mark_thread_read")?.["rid"];
  if (typeof rid !== "string") throw new Error("mark_thread_read was not sent");
  daemonRequests.push(record("w", rid, "running"));
  const restores: (() => void)[] = [];
  const listed = workspace.listRequests;
  let release = () => {};
  replace(restores, workspace, "listRequests", async () => { await new Promise<void>((resolve) => { release = resolve; }); return await listed(); });
  try {
    await acting(() => { socket.fire("close", { code: 1006, reason: "" }); });
    await opened(sockets);
    expect(shown.view.host.querySelector("[aria-label='Mark thread read request']"), "Recent requests lists it").not.toBeNull();
    await acting(() => { release(); });
    await settle(30);
    expect(workspace.getSnapshot().uncertain).toEqual([]);
  } finally {
    for (const restore of restores) restore();
    await acting(() => { navigate({ view: "chat" }); });
  }
});
