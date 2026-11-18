import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { deepArchivePlan, runDeepIdleArchive, type DeepArchiveDeps } from "../src/autonomy/deep_archive.ts";
import { runIdleCompaction } from "../src/autonomy/idle_compaction.ts";
import type { LastRequestCache } from "../src/cache/last_request.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import type { Message } from "../src/engine/types.ts";
import { shoreLog } from "../src/log.ts";
import { stopBackgroundCompactions } from "../src/memory/compaction/background.ts";
import { tryBeginCompaction } from "../src/memory/compaction/manager.ts";
import * as files from "../src/storage/files.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { testTmp } from "./support/tmp.ts";

const datas: string[] = [];
afterEach(async () => {
  for (const data of datas.splice(0)) await stopBackgroundCompactions(data);
});

function said(id: string, role: Message["role"], text: string, extra: Partial<Message> = {}): Message {
  return { msg_id: id, role, content: text, images: [], content_blocks: [{ type: "text", text }], timestamp: "2026-11-18T10:00:00.000Z", ...extra };
}

const TALK = [said("a", "user", "is the lamp lit"), said("b", "assistant", "it is"), said("c", "user", "and the door"), said("d", "assistant", "shut")];
const WAKE = said("e", "assistant", "a note from a wake", { origin: "autonomous" });

async function world(messages: readonly Message[] = TALK) {
  const root = await mkdtemp(testTmp("shore-deep-archive-"));
  const data = join(root, "data");
  datas.push(data);
  mkdirSync(join(root, "config", "characters", "ada", "workspace"), { recursive: true });
  mkdirSync(join(data, "ada", "threads", "main"), { recursive: true });
  writeDurable(threadFile(data, "ada", "main", "active.jsonl"), messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
  const app = defaultAppConfig();
  app.compaction.keep_recent_turns = 0;
  const config: LoadedConfig = {
    app, models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data, cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const happened: unknown[][] = [];
  const cache = {
    invalidate: (character: string, reason: string) => { happened.push(["invalidate", character, reason]); },
    reprimeFromDisk: async (character: string) => { happened.push(["reprime", character]); return { kind: "superseded" as const }; },
  } as unknown as LastRequestCache;
  const deps: DeepArchiveDeps = {
    config, cache, rebuild: { mcpRegistry: { toolDefsFiltered: () => [] } },
    engine: { reload: async (character) => { happened.push(["reload", character]); } },
    notify: (title, body) => { happened.push(["notify", title, body]); },
  };
  return { data, deps, happened, active: () => files.readDurable(threadFile(data, "ada", "main", "active.jsonl")) };
}

describe("a deep-idle archive", () => {
  test("plans to archive everything but a wake's replies at the end, and only when there is something before them", () => {
    expect(deepArchivePlan([...TALK, WAKE])).toEqual({ arm: "archive", tail: 1, archivable: 4 });
    expect(deepArchivePlan([TALK[0] as Message, WAKE])).toEqual({ arm: "archive", tail: 1, archivable: 1 });
    expect(deepArchivePlan([WAKE])).toEqual({ arm: "quiesce", tail: 1 });
  });

  test("archives, reloads the conversation, says so, and rebuilds the cached request", async () => {
    const w = await world([...TALK, WAKE]);
    expect(await runDeepIdleArchive("ada", w.deps)).toEqual({ turnCount: 0, events: [], deepArchiveDone: true });
    expect(w.active()).toBe(`${JSON.stringify(WAKE)}\n`);
    expect(w.happened).toEqual([
      ["reload", "ada"], ["notify", "Shore - ada", "Idle conversation archived (4 messages)"], ["invalidate", "ada", "deep_idle_archive"], ["reprime", "ada"],
    ]);
  });

  test("with nothing to archive is done without doing anything", async () => {
    const w = await world([WAKE]);
    expect(await runDeepIdleArchive("ada", w.deps)).toEqual({ events: [], deepArchiveDone: true });
    expect(w.happened).toEqual([]);
  });

  test("that can't read the conversation, can't start, or can't write the archive is tried again later", async () => {
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    try {
      const unread = await world();
      const reading = spyOn(MessageStore, "loadWithRaw").mockRejectedValue(new Error("unreadable"));
      try {
        expect(await runDeepIdleArchive("ada", unread.deps)).toEqual({ events: [], failed: "unreadable", deepArchiveDone: false });
      } finally {
        reading.mockRestore();
      }

      const held = await world();
      const guard = tryBeginCompaction(held.data, "ada");
      try {
        expect(await runDeepIdleArchive("ada", held.deps)).toEqual({ events: [], failed: "Compaction already running for ada", deepArchiveDone: false });
      } finally {
        guard?.release();
      }

      const full = await world();
      const realWrite = files.writeDurable;
      const write = spyOn(files, "writeDurable").mockImplementation((path, content) => {
        if ((typeof path === "string" ? path : path.key).endsWith("active.jsonl")) throw new Error("disk full");
        realWrite(path, content);
      });
      try {
        expect(await runDeepIdleArchive("ada", full.deps)).toEqual({ events: [], failed: "conversation: failed to write retained messages: disk full", deepArchiveDone: false });
      } finally {
        write.mockRestore();
      }
      expect([unread.happened, held.happened, full.happened]).toEqual([[], [], []]);
    } finally {
      warned.mockRestore();
    }
  });
});

describe("an idle compaction", () => {
  test("says why it didn't archive: nothing to archive, or another compaction holding the character", async () => {
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    try {
      const empty = await world([]);
      expect(await runIdleCompaction("ada", empty.deps)).toEqual({ events: [], failed: "Compaction skipped: empty_or_changed" });
      const held = await world();
      const guard = tryBeginCompaction(held.data, "ada");
      try {
        expect(await runIdleCompaction("ada", held.deps)).toEqual({ events: [], failed: "Compaction already running for ada" });
      } finally {
        guard?.release();
      }
    } finally {
      warned.mockRestore();
    }
  });
});
