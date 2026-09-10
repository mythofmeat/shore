import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { KeyedMutex } from "../util/keyed_mutex.ts";

interface Scope {
  key: string;
  signal: AbortSignal;
  live: boolean;
}
interface Queue {
  epoch: number;
  pending: number;
  active?: AbortController;
}
const queues = new Map<string, Queue>();
const mutex = new KeyedMutex();
const context = new AsyncLocalStorage<Scope>();
type Reader = { reload(): Promise<void> };
const readers = new Map<string, Set<WeakRef<Reader>>>();
const cleanup = new FinalizationRegistry<{ key: string; ref: WeakRef<Reader> }>(({ key, ref }) => {
  const set = readers.get(key);
  set?.delete(ref);
  if (set?.size === 0) readers.delete(key);
});

export function registerConversation(path: string, reader: { reload(): Promise<void> }): void {
  const key = resolve(path);
  const set = readers.get(key) ?? new Set();
  for (const ref of set) if (ref.deref() === undefined) set.delete(ref);
  const ref = new WeakRef(reader);
  set.add(ref);
  cleanup.register(reader, { key, ref });
  readers.set(key, set);
}

export async function refreshConversation(path: string): Promise<void> {
  const key = resolve(path);
  const set = readers.get(key);
  if (set === undefined) return;
  for (const ref of set) {
    const reader = ref.deref();
    if (reader === undefined) set.delete(ref);
    else await reader.reload();
  }
  if (set.size === 0) readers.delete(key);
}

export async function withConversation<T>(
  path: string,
  kind: "turn" | "rewrite" | "update",
  run: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const key = resolve(path);
  const inherited = context.getStore();
  if (inherited?.key === key) {
    if (!inherited.live) throw new Error("Conversation operation has already finished");
    inherited.signal.throwIfAborted();
    return await run(inherited.signal);
  }
  const queue = queues.get(key) ?? { epoch: 0, pending: 0 };
  queues.set(key, queue);
  if (kind === "rewrite") {
    queue.epoch += 1;
    queue.active?.abort(new DOMException("Conversation was rewritten", "AbortError"));
  }
  const epoch = queue.epoch;
  queue.pending += 1;
  try {
    return await mutex.withKey(key, async () => {
      parent?.throwIfAborted();
      if (kind === "turn" && epoch !== queue.epoch) {
        throw new DOMException("Conversation was rewritten before this turn started", "AbortError");
      }
      const controller = new AbortController();
      if (kind === "turn") queue.active = controller;
      const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
      const scope = { key, signal, live: true };
      try {
        return await context.run(scope, () => run(signal));
      } finally {
        scope.live = false;
        delete queue.active;
      }
    });
  } finally {
    queue.pending -= 1;
    if (queue.pending === 0) queues.delete(key);
  }
}
