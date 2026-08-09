import { describe, expect, test } from "bun:test";
import { ClientEvent, SyncState, type MatrixClient, type SyncStateData } from "matrix-js-sdk";

import { awaitInitialSync } from "../src/connections/matrix/bot.ts";

type SyncListener = (state: SyncState, previous: SyncState | null, data?: SyncStateData) => void;

class FakeClient {
  readonly #listeners = new Set<SyncListener>();

  on(_event: typeof ClientEvent.Sync, listener: SyncListener): void {
    this.#listeners.add(listener);
  }

  off(_event: typeof ClientEvent.Sync, listener: SyncListener): void {
    this.#listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  emit(state: SyncState, data?: SyncStateData): void {
    for (const listener of [...this.#listeners]) listener(state, null, data);
  }

  asClient(): MatrixClient {
    return this as unknown as MatrixClient;
  }
}

const unknownToken = (): SyncStateData =>
  ({ error: Object.assign(new Error("[401] Invalid token"), { errcode: "M_UNKNOWN_TOKEN" }) }) as
    SyncStateData;

describe("waiting for the first sync", () => {
  test("a prepared sync resolves and unsubscribes", async () => {
    const client = new FakeClient();
    const waiting = awaitInitialSync(client.asClient(), 10_000);
    client.emit(SyncState.Prepared);
    await waiting;
    expect(client.listenerCount).toBe(0);
  });

  test("a rejected token rejects instead of hanging, and names the errcode", async () => {
    const client = new FakeClient();
    const waiting = awaitInitialSync(client.asClient(), 10_000);
    client.emit(SyncState.Error, unknownToken());
    await expect(waiting).rejects.toThrow("M_UNKNOWN_TOKEN");
    expect(client.listenerCount).toBe(0);
  });

  test("a stopped sync loop rejects too", async () => {
    const client = new FakeClient();
    const waiting = awaitInitialSync(client.asClient(), 10_000);
    client.emit(SyncState.Stopped);
    await expect(waiting).rejects.toThrow("STOPPED");
  });

  test("a sync that never settles gives up rather than blocking startup", async () => {
    const client = new FakeClient();
    const waiting = awaitInitialSync(client.asClient(), 10);
    client.emit(SyncState.Reconnecting);
    await expect(waiting).rejects.toThrow("did not start within 10ms");
    expect(client.listenerCount).toBe(0);
  });

  test("transient states are not failures on their own", async () => {
    const client = new FakeClient();
    const waiting = awaitInitialSync(client.asClient(), 10_000);
    client.emit(SyncState.Reconnecting);
    client.emit(SyncState.Catchup);
    client.emit(SyncState.Syncing);
    await waiting;
  });
});
