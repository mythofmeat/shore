import { IDBFactory } from "fake-indexeddb";

import type { BrowserConnection } from "../../src/browser/connection.ts";

export interface SocketEvent { data?: unknown; code?: number; reason?: string }
export type Answer = (request: Record<string, unknown>) => unknown;

export const HOLD = Symbol("the daemon has not answered yet");

export const HELLO = { type: "hello", v: 1, server_name: "shore", characters: [{ name: "ada" }] };
export const HISTORY = { type: "history", messages: [], config: {}, revision: 1, selected_character: "ada", selected_thread: "story" };
export const LISTING = { character: "ada", threads: [{ id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true }], home: "story", current: "story" };

export function catalogue(request: Record<string, unknown>): unknown {
  switch (request["name"]) {
    case "discover_operations": return { operations: [], requests: [] };
    case "list_characters": return { characters: [{ name: "ada" }] };
    case "list_threads": return LISTING;
    default: return undefined;
  }
}

export class FakeSocket {
  static opened: FakeSocket[] = [];
  readonly sent: Record<string, unknown>[] = [];
  readonly #listeners = new Map<string, ((event: SocketEvent) => void)[]>();
  bufferedAmount = 0;
  answer: Answer = catalogue;

  constructor(readonly url: string, readonly protocol: string) { FakeSocket.opened.push(this); }
  addEventListener(type: string, listener: (event: SocketEvent) => void): void { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]); }
  close(): void { this.fire("closed-by-page"); }
  fire(type: string, event: SocketEvent = {}): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
  receive(frame: unknown): void { this.fire("message", { data: JSON.stringify(frame) }); }

  send(text: string): void {
    const request = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(request);
    if (request["type"] !== "command") return;
    let data: unknown;
    try { data = this.answer(request); } catch (error) {
      queueMicrotask(() => { this.receive({ type: "request_finished", rid: request["rid"], outcome: "failed", error: { code: "internal_error", message: (error as Error).message } }); });
      return;
    }
    if (data === undefined || data === HOLD) return;
    queueMicrotask(() => {
      this.receive({ type: "command_output", rid: request["rid"], name: request["name"], data });
      this.receive({ type: "request_finished", rid: request["rid"], outcome: "completed" });
    });
  }
}

export const keptSettings = { values: {} as Record<string, string>, lists: 0, saves: [] as Record<string, string>[] };

export function forgetKeptSettings(): void { Object.assign(keptSettings, { values: {}, lists: 0, saves: [] }); }

async function answerPage(path: string, init: RequestInit = {}): Promise<Response> {
  await Promise.resolve();
  if (path === "/api/preferences/list") keptSettings.lists += 1;
  else if (path === "/api/preferences") {
    const { values } = JSON.parse(init.body as string) as { values: Record<string, string> };
    keptSettings.saves.push(values);
    keptSettings.values = { ...keptSettings.values, ...values };
  } else return Response.json({ contract: "c1", protocol: 2, expires_at: Date.now() + 3_600_000, max_message_bytes: 1_000_000, max_pending_requests: 32 });
  return Response.json({ values: keptSettings.values });
}

export function replace(restores: (() => void)[], target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => { if (original === undefined) Reflect.deleteProperty(target, key); else Object.defineProperty(target, key, original); });
}

export async function connect(connection: BrowserConnection, restores: (() => void)[], answer: Answer = catalogue): Promise<FakeSocket> {
  replace(restores, globalThis, "fetch", answerPage);
  replace(restores, globalThis, "WebSocket", FakeSocket);
  replace(restores, globalThis, "indexedDB", new IDBFactory());
  replace(restores, navigator, "locks", undefined);
  connection.connect();
  await Bun.sleep(5);
  const socket = FakeSocket.opened.at(-1);
  if (socket === undefined) throw new Error("no socket was opened");
  socket.answer = answer;
  socket.fire("open");
  socket.receive(HELLO);
  socket.receive(HISTORY);
  await Bun.sleep(5);
  return socket;
}
