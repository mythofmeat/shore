import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { newMessageVersion } from "../src/engine/versions.ts";
import { loadMessagesForCompaction } from "../src/memory/compaction/background.ts";
import { backgroundCoverageNotice } from "../src/memory/compaction/manager.ts";
import {
  planCompactionCoverage,
  releaseCompactionCoverage,
} from "../src/memory/compaction/run.ts";
import { claimUncovered } from "../src/memory/coverage.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";

const STAMP = "2026-09-05T00:00:00Z";

function message(id: string, role: Message["role"], text: string, version: string): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: STAMP,
    version,
  };
}

function conversation(): Message[] {
  return [
    message("m_1", "user", "morning", newMessageVersion()),
    message("m_2", "assistant", "morning to you", newMessageVersion()),
    message("m_3", "user", "did you sleep", newMessageVersion()),
    message("m_4", "assistant", "in a manner of speaking", newMessageVersion()),
    message("m_5", "user", "tell me about boats", newMessageVersion()),
    message("m_6", "assistant", "they float", newMessageVersion()),
  ];
}

async function world(messages: Message[] = conversation()): Promise<{
  config: LoadedConfig;
  dataDir: string;
  messages: Message[];
}> {
  const root = await mkdtemp(testTmp("shore-coverage-plan-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  await mkdir(join(dirs.data, "ada", "threads", "main"), { recursive: true });
  await writeFile(
    join(dirs.data, "ada", "threads", "main", "active.jsonl"),
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
  );

  const app = defaultAppConfig();
  return {
    dataDir: dirs.data,
    messages,
    config: { app, models: emptyCatalog(), providers: ProviderRegistry.empty(), dirs, rawTable: undefined },
  };
}

async function plan(w: Awaited<ReturnType<typeof world>>, keepTurns: number) {
  const loaded = await loadMessagesForCompaction(w.dataDir, "ada", "main");
  return await planCompactionCoverage(
    "ada",
    "main",
    w.config,
    loaded,
    { keepTurnsOverride: keepTurns },
  );
}

function cover(dataDir: string, messages: readonly Message[]): void {
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    const claim = claimUncovered(store, "ada", "compaction", messages);
    store.commitMemoryCoverage("ada", "compaction", claim.claim);
  } finally {
    store.close();
  }
}

describe("deciding whether a compaction has anything new to write", () => {
  test("an untouched range is claimed in full and none of it is background", async () => {
    const w = await world();
    const planned = await plan(w, 1);
    expect(planned.redundant).toBe(false);
    expect(required(planned.coverage).claimed).toBe(4);
    expect(required(planned.coverage).background).toBe(0);
  });

  test("a range another branch already wrote up rotates without a second LLM pass", async () => {
    const w = await world();
    cover(w.dataDir, w.messages.slice(0, 4));

    const planned = await plan(w, 1);
    expect(planned.redundant).toBe(true);
    expect(planned.coverage).toBeUndefined();
  });

  test("a partly covered range claims only the new material and keeps the rest as background", async () => {
    const w = await world();
    cover(w.dataDir, w.messages.slice(0, 2));

    const planned = await plan(w, 1);
    expect(planned.redundant).toBe(false);
    expect(required(planned.coverage).background).toBe(2);
    expect(required(planned.coverage).claimed).toBe(2);
  });

  test("a claim another pass holds is not handed out twice, and is not mistaken for done", async () => {
    const w = await world();
    const first = await plan(w, 1);
    const second = await plan(w, 1);
    expect(required(first.coverage).claimed).toBe(4);
    expect(required(second.coverage).claimed).toBe(0);
    expect(second.redundant).toBe(false);
  });

  test("releasing an abandoned pass's claim gives the material back", async () => {
    const w = await world();
    const first = await plan(w, 1);
    releaseCompactionCoverage(w.dataDir, "ada", required(first.coverage).claim);

    const second = await plan(w, 1);
    expect(required(second.coverage).claimed).toBe(4);
  });

  test("legacy messages with no version are always treated as unwritten", async () => {
    const w = await world(
      conversation().map((m) => {
        const { version: _dropped, ...rest } = m;
        return rest;
      }),
    );
    const planned = await plan(w, 1);
    expect(planned.redundant).toBe(false);
    expect(required(planned.coverage).unversioned).toBe(4);
  });

  test("nothing to archive means nothing to claim", async () => {
    const w = await world();
    const planned = await plan(w, 99);
    expect(planned.redundant).toBe(false);
    expect(planned.coverage).toBeUndefined();
  });
});

describe("telling the compaction pass what it is looking at", () => {
  test("a wholly new range gets no background notice", () => {
    expect(
      backgroundCoverageNotice({ claim: "c", unit: "u", claimed: 3, background: 0, unversioned: 0 }),
    ).toBeUndefined();
  });

  test("inherited context is named as background rather than deleted from the prompt", () => {
    const notice = backgroundCoverageNotice({
      claim: "c",
      unit: "u",
      claimed: 2,
      background: 5,
      unversioned: 1,
    });
    expect(notice).toContain("oldest 5 message(s)");
    expect(notice).toContain("do not write them up again");
    expect(notice).toContain("3 message(s) that follow");
  });
});
