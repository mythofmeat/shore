import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";

import type { CommandDeps, CommandSession } from "../src/commands/dispatch.ts";
import { threadListingContext } from "../src/commands/thread_context.ts";
import type { ConversationEngine } from "../src/engine/conversation.ts";
import { testTmp } from "./support/tmp.ts";

test("a thread command's context marks the thread whose cache is kept warm and runs its work as a snapshot, when there are both", async () => {
  const session = { dataDir: await mkdtemp(testTmp("shore-thread-context-")) } as unknown as CommandSession;
  const engine = { characterName: "ada", thread: "main" } as unknown as ConversationEngine;
  const threads = { listThreads: () => [{ id: "main", created_at: "2026-11-18T00:00:00Z", compaction: true }] };
  const ran: string[] = [];
  const full = await threadListingContext({
    threads,
    keepalive: { keepalive: { warmThread: () => "main" } },
    archive: { withSnapshot: async <T>(run: () => Promise<T>) => { ran.push("snapshot"); return await run(); } },
  } as unknown as CommandDeps, engine, session);
  await full.withSnapshot?.(async () => { ran.push("work"); });
  expect([full.warm, ran]).toEqual(["main", ["snapshot", "work"]]);

  const bare = await threadListingContext({ threads, keepalive: { keepalive: { warmThread: () => undefined } } } as unknown as CommandDeps, engine, session);
  expect(["warm" in bare, "withSnapshot" in bare]).toEqual([false, false]);
});
