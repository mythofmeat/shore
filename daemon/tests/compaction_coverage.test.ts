import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
import {
  openArchivalCommit,
  readLiveSource,
  resolveArchivalPlan,
} from "../src/memory/compaction/plan.ts";
import type { CompactionRunOptions } from "../src/memory/compaction/run.ts";
import { hashCompactionSource } from "../src/memory/compaction/checkpoint.ts";
import { backgroundCoverageNotice } from "../src/memory/compaction/manager.ts";
import {
  planCompactionCoverage,
  releaseCompactionCoverage,
  rotateWithoutMemoryWrite,
  runCompactionPass,
} from "../src/memory/compaction/run.ts";
import { COVERAGE_LEASE_MS, claimUncovered } from "../src/memory/coverage.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";

const STAMP = "2026-09-05T00:00:00Z";

function jsonl(messages: readonly Message[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
}

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

async function writeCheckpoint(
  dataDir: string,
  coverageClaim: string,
  sourceContent: string,
  splitAt = 4,
): Promise<void> {
  await writeFile(
    join(dataDir, "ada", "threads", "main", "compaction-checkpoint.json"),
    JSON.stringify({
      version: 1,
      id: "cp",
      character: "ada",
      createdAt: STAMP,
      updatedAt: STAMP,
      state: "running",
      sourceContent,
      sourceHash: hashCompactionSource(sourceContent),
      splitAt,
      compactedTurns: 2,
      coverageClaim,
      request: { api_key: "" },
      loop: {
        writesApplied: [],
        toolsCalled: [],
        dryRunPreviews: [],
        toolRounds: 0,
        maxRoundsHit: false,
        dryRun: false,
        pendingResults: [],
        pendingUseCount: 0,
      },
    }),
  );
}

interface Planned {
  redundant: boolean;
  blocked?: boolean;
  coverage?: { claim: string; claimed: number; background: number; fresh: number };
  checkpointId?: string;
}

async function planAuto(
  w: Awaited<ReturnType<typeof world>>,
  keepRecentTurns: number,
): Promise<Planned> {
  w.config.app.memory.compaction.keep_recent_turns = keepRecentTurns;
  w.config.app.memory.compaction.max_context_tokens = 0;
  return await planWith(w, {});
}

async function plan(
  w: Awaited<ReturnType<typeof world>>,
  keepTurns: number,
): Promise<Planned> {
  return await planWith(w, { keepTurnsOverride: keepTurns });
}

async function planWith(
  w: Awaited<ReturnType<typeof world>>,
  options: CompactionRunOptions,
): Promise<Planned> {
  const loaded = await loadMessagesForCompaction(w.dataDir, "ada", "main");
  const compaction = w.config.app.memory.compaction;
  const archival = await resolveArchivalPlan(w.dataDir, "ada", "main", loaded, {
    keepRecentTurns: compaction.keep_recent_turns,
    maxContextTokens: compaction.max_context_tokens,
    ...(options.keepTurnsOverride === undefined
      ? {}
      : { keepTurnsOverride: options.keepTurnsOverride }),
  });
  if (archival === undefined) return { redundant: false };
  return {
    ...planCompactionCoverage("ada", w.config, archival, options),
    ...(archival.checkpoint === undefined ? {} : { checkpointId: archival.checkpoint.id }),
  };
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

  test("a pass that could claim nothing blocks rather than archiving unprocessed material", async () => {
    const w = await world();
    const first = await plan(w, 1);
    expect(required(first.coverage).claimed).toBe(4);

    const second = await plan(w, 1);
    expect(second.blocked).toBe(true);
    expect(second.redundant).toBe(false);
    expect(second.coverage).toBeUndefined();
  });

  test("a range another pass half-owns blocks rather than archiving the rest of it", async () => {
    const w = await world();
    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      store.claimMemoryCoverage(
        "ada",
        "compaction",
        [required(required(w.messages[2]).version)],
        "someone-else",
        "their-unit",
        Date.now(),
        COVERAGE_LEASE_MS,
      );
    } finally {
      store.close();
    }

    const planned = await plan(w, 1);
    expect(planned.blocked).toBe(true);
    expect(planned.coverage).toBeUndefined();
  });

  test("the blocked pass leaves nothing claimed behind for the other one to trip on", async () => {
    const w = await world();
    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      store.claimMemoryCoverage(
        "ada",
        "compaction",
        [required(required(w.messages[2]).version)],
        "someone-else",
        "their-unit",
        Date.now(),
        COVERAGE_LEASE_MS,
      );
    } finally {
      store.close();
    }
    await plan(w, 1);

    const after = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      for (const untouched of [w.messages[0], w.messages[1], w.messages[3]]) {
        expect(
          after.memoryCoverageState("ada", "compaction", required(required(untouched).version)),
        ).toBeUndefined();
      }
      after.releaseMemoryCoverage("ada", "compaction", "someone-else");
    } finally {
      after.close();
    }

    const retried = await plan(w, 1);
    expect(retried.blocked).toBeUndefined();
    expect(required(retried.coverage).claimed).toBe(4);
  });

  test("a checkpoint whose range another branch finished is retired, not blocked forever", async () => {
    const w = await world();
    const frozen = jsonl(w.messages);
    await writeCheckpoint(w.dataDir, "cl_paused", frozen);
    cover(w.dataDir, w.messages.slice(0, 4));

    const planned = await planAuto(w, 1);
    expect(planned.blocked).toBeUndefined();
    expect(planned.redundant).toBe(true);
    expect(planned.checkpointId).toBe("cp");
  });

  test("a redundant range with no checkpoint has nothing to retire", async () => {
    const w = await world();
    cover(w.dataDir, w.messages.slice(0, 4));

    const planned = await planAuto(w, 1);
    expect(planned.redundant).toBe(true);
    expect(planned.checkpointId).toBeUndefined();
  });

  test("blocking leaves the first pass's claim alone so it can still finish", async () => {
    const w = await world();
    const first = await plan(w, 1);
    await plan(w, 1);

    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      expect(
        store.commitMemoryCoverage("ada", "compaction", required(first.coverage).claim),
      ).toBe(4);
    } finally {
      store.close();
    }
  });

  test("a resumed pass reclaims the material its own checkpoint is holding", async () => {
    const w = await world();
    const first = await plan(w, 1);
    const claim = required(first.coverage).claim;
    await writeCheckpoint(w.dataDir, claim, jsonl(w.messages));

    const resumed = await plan(w, 1);
    expect(resumed.blocked).toBeUndefined();
    expect(required(resumed.coverage).claim).toBe(claim);
    expect(required(resumed.coverage).claimed).toBe(4);
  });

  test("a resumed pass claims the range its checkpoint froze, not what has arrived since", async () => {
    const w = await world();
    const frozen = jsonl(w.messages);
    const first = await planAuto(w, 1);
    const claim = required(first.coverage).claim;
    await writeCheckpoint(w.dataDir, claim, frozen);

    const arrived = [
      message("m_7", "user", "one more thing", newMessageVersion()),
      message("m_8", "assistant", "of course", newMessageVersion()),
    ];
    await writeFile(
      join(w.dataDir, "ada", "threads", "main", "active.jsonl"),
      frozen + jsonl(arrived),
    );

    const resumed = await planAuto(w, 1);
    expect(required(resumed.coverage).claim).toBe(claim);
    expect(required(resumed.coverage).claimed).toBe(4);
    expect(required(resumed.coverage).background + required(resumed.coverage).fresh).toBe(4);

    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      store.commitMemoryCoverage("ada", "compaction", claim);
      const late = arrived.map((m) => required(m.version));
      expect(store.coveredMemoryVersions("ada", "compaction", late).size).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a checkpoint the source outgrew is not resumed, so the current range is planned", async () => {
    const w = await world();
    const first = await plan(w, 1);
    await writeCheckpoint(w.dataDir, required(first.coverage).claim, "not this conversation\n");

    const replanned = await plan(w, 1);
    expect(replanned.blocked).toBe(true);
  });

  test("an edit inside the inherited range keeps that message out of the background", async () => {
    const w = await world();
    cover(w.dataDir, w.messages.slice(0, 4));
    const edited = { ...required(w.messages[1]), version: newMessageVersion() };
    await writeFile(
      join(w.dataDir, "ada", "threads", "main", "active.jsonl"),
      [w.messages[0], edited, ...w.messages.slice(2)]
        .map((m) => JSON.stringify(m))
        .join("\n") + "\n",
    );

    const planned = await plan(w, 1);
    expect(planned.redundant).toBe(false);
    expect(required(planned.coverage).background).toBe(1);
    expect(required(planned.coverage).fresh).toBe(3);
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
    expect(required(planned.coverage).background).toBe(0);
    expect(required(planned.coverage).fresh).toBe(4);
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
      backgroundCoverageNotice({ claim: "c", unit: "u", claimed: 3, background: 0, fresh: 3 }),
    ).toBeUndefined();
  });

  test("inherited context is named as background rather than deleted from the prompt", () => {
    const notice = backgroundCoverageNotice({
      claim: "c",
      unit: "u",
      claimed: 3,
      background: 5,
      fresh: 3,
    });
    expect(notice).toContain("oldest 5 message(s)");
    expect(notice).toContain("do not write them up again");
    expect(notice).toContain("3 message(s) that follow");
  });
});

describe("retiring a pass another branch finished for it", () => {
  async function runPass(w: Awaited<ReturnType<typeof world>>) {
    w.config.app.memory.compaction.keep_recent_turns = 1;
    w.config.app.memory.compaction.max_context_tokens = 0;
    return await runCompactionPass("ada", {
      config: w.config,
      generate: () => {
        throw new Error("the memory pass must not run");
      },
    });
  }

  test("the checkpoint is cleared and its turns rotate into the archive", async () => {
    const w = await world();
    await writeCheckpoint(w.dataDir, "cl_paused", jsonl(w.messages));
    cover(w.dataDir, w.messages.slice(0, 4));

    const outcome = await runPass(w);

    expect(outcome?.kind).toBe("rotated");
    expect(
      existsSync(join(w.dataDir, "ada", "threads", "main", "compaction-checkpoint.json")),
    ).toBe(false);
    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      expect(store.segmentCount("ada")).toBe(1);
    } finally {
      store.close();
    }
  });

  test("retiring a pass archives the range it froze, not the turns that arrived after", async () => {
    const w = await world();
    const frozen = jsonl(w.messages);
    await writeCheckpoint(w.dataDir, "cl_paused", frozen);
    cover(w.dataDir, w.messages.slice(0, 4));

    const arrived = [
      message("m_7", "user", "one more thing", newMessageVersion()),
      message("m_8", "assistant", "of course", newMessageVersion()),
    ];
    await writeFile(
      join(w.dataDir, "ada", "threads", "main", "active.jsonl"),
      frozen + jsonl(arrived),
    );

    const outcome = await runPass(w);
    expect(outcome?.kind).toBe("rotated");

    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      const archived = store.readSegment("ada", 0);
      expect(archived.map((m) => m.msg_id)).toEqual(["m_1", "m_2", "m_3", "m_4"]);
      const late = arrived.map((m) => required(m.version));
      expect(store.coveredMemoryVersions("ada", "compaction", late).size).toBe(0);
    } finally {
      store.close();
    }

    const kept = await loadMessagesForCompaction(w.dataDir, "ada", "main");
    expect([...kept.store.messages()].map((m) => m.msg_id)).toEqual([
      "m_5",
      "m_6",
      "m_7",
      "m_8",
    ]);
  });

  test("a checkpoint the conversation outgrew does not dictate the range it rotates", async () => {
    const w = await world();
    await writeCheckpoint(w.dataDir, "cl_paused", "not this conversation\n", 2);
    cover(w.dataDir, w.messages.slice(0, 4));

    const outcome = await runPass(w);
    expect(outcome?.kind).toBe("rotated");

    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      expect(store.readSegment("ada", 0).map((m) => m.msg_id)).toEqual([
        "m_1",
        "m_2",
        "m_3",
        "m_4",
      ]);
    } finally {
      store.close();
    }
  });

  test("a pass that already archived its turns is retired without archiving them twice", async () => {
    const w = await world();
    await writeCheckpoint(w.dataDir, "cl_paused", jsonl(w.messages));
    cover(w.dataDir, w.messages.slice(0, 4));

    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      const idx = store.beginCompaction(
        "ada",
        {
          file: HISTORY_DB_FILE,
          message_count: 4,
          compacted_at: STAMP,
          compaction_id: "cp",
        },
        w.messages.slice(0, 4),
        "before",
        "after",
      );
      store.finishCompaction("ada", idx);
    } finally {
      store.close();
    }

    const outcome = await runPass(w);

    expect(outcome).toBeUndefined();
    expect(
      existsSync(join(w.dataDir, "ada", "threads", "main", "compaction-checkpoint.json")),
    ).toBe(false);
    const after = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      expect(after.segmentCount("ada")).toBe(1);
    } finally {
      after.close();
    }
  });

  test("the wedge is gone: the next plan neither blocks nor re-retires", async () => {
    const w = await world();
    await writeCheckpoint(w.dataDir, "cl_paused", jsonl(w.messages));
    cover(w.dataDir, w.messages.slice(0, 4));

    expect((await planAuto(w, 1)).checkpointId).toBe("cp");
    await runPass(w);

    const settled = await planAuto(w, 1);
    expect(settled.blocked).toBeUndefined();
    expect(settled.checkpointId).toBeUndefined();
  });
});

describe("one plan carried from resolution to archival", () => {
  async function resolve(
    w: Awaited<ReturnType<typeof world>>,
    options: { keepRecentTurns: number; restart?: boolean; keepTurnsOverride?: number },
  ) {
    const loaded = await loadMessagesForCompaction(w.dataDir, "ada", "main");
    return await resolveArchivalPlan(w.dataDir, "ada", "main", loaded, {
      maxContextTokens: 0,
      ...options,
    });
  }

  test("a resumed plan freezes the source, the split and the versions together", async () => {
    const w = await world();
    const frozen = jsonl(w.messages);
    await writeCheckpoint(w.dataDir, "cl_paused", frozen);

    const arrived = [
      message("m_7", "user", "one more thing", newMessageVersion()),
      message("m_8", "assistant", "of course", newMessageVersion()),
    ];
    await writeFile(
      join(w.dataDir, "ada", "threads", "main", "active.jsonl"),
      frozen + jsonl(arrived),
    );

    const resolved = required(await resolve(w, { keepRecentTurns: 1 }));
    expect(resolved.resumed).toBe(true);
    expect(resolved.sourceContent).toBe(frozen);
    expect(resolved.splitAt).toBe(4);
    expect(resolved.archival.map((m) => m.msg_id)).toEqual(["m_1", "m_2", "m_3", "m_4"]);
    expect(resolved.versions).toEqual(w.messages.slice(0, 4).map((m) => required(m.version)));
    expect(resolved.checkpoint?.id).toBe("cp");
  });

  test("the commit it opens keeps every turn the frozen range does not cover", async () => {
    const w = await world();
    const frozen = jsonl(w.messages);
    await writeCheckpoint(w.dataDir, "cl_paused", frozen);
    const arrived = [message("m_7", "user", "one more thing", newMessageVersion())];
    await writeFile(
      join(w.dataDir, "ada", "threads", "main", "active.jsonl"),
      frozen + jsonl(arrived),
    );

    const resolved = required(await resolve(w, { keepRecentTurns: 1 }));
    const commit = required(
      openArchivalCommit(
        resolved,
        await readLiveSource(w.dataDir, "ada", "main", resolved.sourceContent),
      ),
    );
    expect(commit.retained).toBe(3);
    expect(commit.retainedTurns).toBe(2);
    expect(commit.liveContent).toBe(frozen + jsonl(arrived));
  });

  test("a conversation rewritten under the plan refuses to commit", async () => {
    const w = await world();
    const resolved = required(await resolve(w, { keepRecentTurns: 1 }));
    await writeFile(
      join(w.dataDir, "ada", "threads", "main", "active.jsonl"),
      jsonl([message("m_9", "user", "a different conversation", newMessageVersion())]),
    );

    expect(
      openArchivalCommit(
        resolved,
        await readLiveSource(w.dataDir, "ada", "main", resolved.sourceContent),
      ),
    ).toBeUndefined();
  });

  test("a rotation archives exactly the range the plan resolved", async () => {
    const w = await world();
    w.config.app.memory.compaction.write_memory = false;
    w.config.app.memory.compaction.keep_recent_turns = 1;
    w.config.app.memory.compaction.max_context_tokens = 0;

    const outcome = await runCompactionPass("ada", {
      config: w.config,
      generate: () => {
        throw new Error("no memory pass here");
      },
    });
    expect(outcome?.kind).toBe("rotated");

    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      expect(store.readSegment("ada", 0).map((m) => m.msg_id)).toEqual([
        "m_1",
        "m_2",
        "m_3",
        "m_4",
      ]);
    } finally {
      store.close();
    }
    const kept = await loadMessagesForCompaction(w.dataDir, "ada", "main");
    expect([...kept.store.messages()].map((m) => m.msg_id)).toEqual(["m_5", "m_6"]);
  });

  test("a rotation refuses to commit a plan the conversation moved out from under", async () => {
    const w = await world();
    w.config.app.memory.compaction.keep_recent_turns = 1;
    w.config.app.memory.compaction.max_context_tokens = 0;
    const resolved = required(await resolve(w, { keepRecentTurns: 1 }));

    await writeFile(
      join(w.dataDir, "ada", "threads", "main", "active.jsonl"),
      jsonl([message("m_9", "user", "a different conversation", newMessageVersion())]),
    );

    const outcome = await rotateWithoutMemoryWrite(
      "ada",
      "main",
      { config: w.config, generate: () => { throw new Error("unused"); } },
      w.config,
      resolved,
      join(w.dataDir, "ada", "threads", "main"),
      {},
    );

    expect(outcome).toBeUndefined();
    const store = HistoryStore.open(join(w.dataDir, HISTORY_DB_FILE));
    try {
      expect(store.segmentCount("ada")).toBe(0);
    } finally {
      store.close();
    }
  });

  test("restart is part of resolving the plan, not something applied after it", async () => {
    const w = await world();
    await writeCheckpoint(w.dataDir, "cl_paused", jsonl(w.messages));

    expect(required(await resolve(w, { keepRecentTurns: 1 })).resumed).toBe(true);
    expect(required(await resolve(w, { keepRecentTurns: 1, restart: true })).resumed).toBe(false);
  });

  test("an explicit keep-turns count that moves the split refuses the frozen one", async () => {
    const w = await world();
    await writeCheckpoint(w.dataDir, "cl_paused", jsonl(w.messages));

    const resolved = required(await resolve(w, { keepRecentTurns: 1, keepTurnsOverride: 0 }));
    expect(resolved.resumed).toBe(false);
    expect(resolved.splitAt).toBe(6);
  });
});
