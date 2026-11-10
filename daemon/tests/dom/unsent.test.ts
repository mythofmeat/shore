import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import type { BrowserConnection, ConnectionUpdate } from "../../src/browser/connection.ts";
import type { WebRequestInfo } from "../../src/protocol/WebRequestInfo.ts";
import type { WebRequestList } from "../../src/protocol/WebRequestList.ts";
import { useDom } from "./dom.ts";

useDom();

const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
beforeAll(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: new IDBFactory() });
  Object.defineProperty(navigator, "locks", { configurable: true, writable: true, value: undefined });
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "indexedDB");
  if (originalLocks === undefined) Reflect.deleteProperty(navigator, "locks"); else Object.defineProperty(navigator, "locks", originalLocks);
});

async function clear(): Promise<void> {
  const { forgetSending, unclaimedSending } = await import("../../src/browser/drafts.ts");
  for (const message of await unclaimedSending()) await forgetSending(message.rid);
}

beforeEach(clear);

const request = (rid: string, phase: WebRequestInfo["phase"], accepted?: boolean): WebRequestInfo => ({
  id: rid, rid, operation: "message", label: "Message", character: null, thread: null, started_at: 0, expires_at: 0, phase, result_omitted: false, ...(accepted === undefined ? {} : { accepted }),
});

function rig(requests: () => WebRequestInfo[] | Promise<WebRequestInfo[]>) {
  const listeners = new Set<(update: ConnectionUpdate) => void>();
  const connection = { subscribe: (listener: (update: ConnectionUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as BrowserConnection;
  let listed = 0;
  const restored: [string, number][] = [];
  const emit = (update: ConnectionUpdate) => { for (const listener of listeners) listener(update); };
  const list = async (): Promise<WebRequestList> => { listed += 1; return { requests: await requests(), max_records: 50, max_result_bytes: 1024 }; };
  return { connection, list, restored, emit, listed: () => listed };
}

async function sent(rid: string, conversation = "ada/main", text = rid): Promise<void> {
  const { browserDraft, handOverSending } = await import("../../src/browser/drafts.ts");
  const draft = browserDraft(conversation);
  await draft.load();
  await draft.send(rid, { text, images: [] });
  handOverSending(rid);
}

async function settled(): Promise<void> { await Bun.sleep(20); }

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("the unsent messages were never settled");
    await Bun.sleep(2);
  }
}

describe("messages that never reached the daemon", () => {
  test("go back to their drafts once connected, saved ones are forgotten, and running ones are waited for", async () => {
    const { UnsentMessages } = await import("../../src/browser/chat/unsent.ts");
    const { unclaimedSending, browserDraft } = await import("../../src/browser/drafts.ts");
    await sent("r_lost", "ada/main", "lost words");
    await sent("r_saved");
    await sent("r_accepted");
    await sent("r_running");
    const link = rig(() => [request("r_saved", "completed"), request("r_accepted", "failed", true), request("r_running", "running"), request("r_failed", "failed")]);
    const unsent = new UnsentMessages(link.connection, link.list, (message, dropped) => { link.restored.push([message.rid, dropped]); });
    expect(unsent.list).toBe(link.list);
    link.emit({ kind: "status", status: "connecting", detail: "" });
    await settled();
    expect(link.listed()).toBe(0);
    link.emit({ kind: "status", status: "ready", detail: "" });
    await until(async () => (await unclaimedSending()).length === 1);
    expect(link.restored).toEqual([["r_lost", 0]]);
    expect(browserDraft("ada/main").current?.text).toBe("lost words");
    expect((await unclaimedSending()).map((message) => message.rid)).toEqual(["r_running"]);
  });

  test("a running message is checked again when it finishes, and other requests finishing are ignored", async () => {
    const { UnsentMessages } = await import("../../src/browser/chat/unsent.ts");
    const { unclaimedSending } = await import("../../src/browser/drafts.ts");
    await sent("r_1");
    let phase: WebRequestInfo["phase"] = "running";
    const link = rig(() => [request("r_1", phase)]);
    new UnsentMessages(link.connection, link.list, (message) => { link.restored.push([message.rid, 0]); });
    link.emit({ kind: "status", status: "ready", detail: "" });
    await until(() => link.listed() === 1);
    await settled();
    link.emit({ kind: "frame", message: { type: "request_finished", rid: "someone-else", outcome: "completed" } });
    link.emit({ kind: "frame", message: { type: "phase", phase: "x" } });
    link.emit({ kind: "status", status: "reconnecting", detail: "" });
    await settled();
    expect(link.listed()).toBe(1);
    phase = "completed";
    link.emit({ kind: "frame", message: { type: "request_finished", rid: "r_1", outcome: "completed" } });
    await until(async () => link.listed() === 2 && (await unclaimedSending()).length === 0);
    await settled();
    await sent("r_2");
    link.emit({ kind: "frame", message: { type: "request_finished", rid: "r_1", outcome: "completed" } });
    await settled();
    expect(link.listed(), "nothing is waited for any more").toBe(2);
  });

  test("a message another tab settled is no longer waited for", async () => {
    const { UnsentMessages } = await import("../../src/browser/chat/unsent.ts");
    const { forgetSending } = await import("../../src/browser/drafts.ts");
    await sent("r_1");
    const link = rig(() => [request("r_1", "running")]);
    new UnsentMessages(link.connection, link.list, () => {});
    link.emit({ kind: "status", status: "ready", detail: "" });
    await until(() => link.listed() === 1);
    await settled();
    await forgetSending("r_1");
    link.emit({ kind: "status", status: "ready", detail: "" });
    await settled();
    await sent("r_2");
    link.emit({ kind: "frame", message: { type: "request_finished", rid: "r_1", outcome: "completed" } });
    await settled();
    expect(link.listed()).toBe(1);
  });

  test("with nothing unsent the daemon is not asked, and checks asked for while one runs happen once after it", async () => {
    const { UnsentMessages } = await import("../../src/browser/chat/unsent.ts");
    let release: () => void = () => {};
    let calls = 0;
    const link = rig(async () => { calls += 1; if (calls === 1) await new Promise<void>((resolve) => { release = resolve; }); return [request("r_1", "running")]; });
    const unsent = new UnsentMessages(link.connection, link.list, () => {});
    unsent.check();
    await settled();
    expect(link.listed()).toBe(0);
    await sent("r_1");
    unsent.check();
    await until(() => link.listed() === 1);
    unsent.check();
    unsent.check();
    link.emit({ kind: "frame", message: { type: "request_finished", rid: "unrelated", outcome: "completed" } });
    release();
    await until(() => link.listed() === 2);
    await settled();
    expect(link.listed(), "one more check covers every request made while busy").toBe(2);
    unsent.check();
    await until(() => link.listed() === 3);
  });

  test("a failing check is dropped quietly and the next one runs", async () => {
    const { UnsentMessages } = await import("../../src/browser/chat/unsent.ts");
    let fail = true;
    const link = rig(() => { if (fail) throw new Error("daemon down"); return []; });
    const unsent = new UnsentMessages(link.connection, link.list, () => {});
    await sent("r_1");
    unsent.check();
    await until(() => link.listed() === 1);
    await settled();
    fail = false;
    unsent.check();
    await until(() => link.listed() === 2);
  });
});
