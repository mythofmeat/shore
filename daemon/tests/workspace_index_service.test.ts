import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { toF32, type Embedder } from "../src/llm/embed";
import { indexPendingBatch, type RetrievalConfig } from "../src/memory/workspace_index";
import { WorkspaceIndexService } from "../src/memory/workspace_index_service";
import { WorkspaceIndexStore } from "../src/memory/workspace_store";

const CONFIG: RetrievalConfig = {
  maxFileBytes: 1_000_000,
  maxIndexedFiles: 500,
  maxTotalIndexedBytes: 10_000_000,
  maxEmbedCharsPerFile: 4000,
  binary: "skip",
};

class CountingEmbedder implements Embedder {
  readonly modelId = "topic-v1";
  readonly dimensions = 2;
  batches = 0;
  documents = 0;
  fail: string | undefined;

  async embed(inputs: string[]): Promise<number[][]> {
    this.batches += 1;
    this.documents += inputs.length;
    if (this.fail !== undefined) throw new Error(this.fail);
    return inputs.map((text) => [toF32(text.length / 100), 1]);
  }
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wsis-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function workspaceOf(count: number): Promise<string> {
  const ws = join(root, `ws-${count}-${Math.random()}`);
  for (let i = 0; i < count; i += 1) {
    const path = join(ws, `f${String(i).padStart(3, "0")}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `file number ${i}`);
    await utimes(path, 1000, 1000);
  }
  return ws;
}

function statsOf(indexPath: string) {
  const store = WorkspaceIndexStore.open(indexPath);
  try {
    return store.stats();
  } finally {
    store.close();
  }
}

describe("indexPendingBatch", () => {
  test("one call embeds at most one batch and reports the rest as pending", async () => {
    const ws = await workspaceOf(10);
    const indexPath = join(root, "a.db");
    const embedder = new CountingEmbedder();

    const first = await indexPendingBatch({
      workspaceDir: ws,
      retrievalConfig: CONFIG,
      embedder,
      indexPath,
      maxBatchItems: 4,
    });

    expect(first).toEqual({ embedded: 4, pending: 6, files: 10 });
    expect(embedder.documents).toBe(4);
    expect(statsOf(indexPath).embedded).toBe(4);
  });

  test("repeated calls drain the workspace and then go quiet", async () => {
    const ws = await workspaceOf(10);
    const indexPath = join(root, "b.db");
    const embedder = new CountingEmbedder();
    const opts = {
      workspaceDir: ws,
      retrievalConfig: CONFIG,
      embedder,
      indexPath,
      maxBatchItems: 4,
    };

    let rounds = 0;
    let last = await indexPendingBatch(opts);
    while (last.pending > 0 && rounds < 10) {
      last = await indexPendingBatch(opts);
      rounds += 1;
    }

    expect(last.pending).toBe(0);
    expect(statsOf(indexPath).embedded).toBe(10);

    const quiet = await indexPendingBatch(opts);
    expect(quiet.embedded).toBe(0);
    expect(embedder.documents).toBe(10);
  });

  test("a file that changes is picked up on the next pass", async () => {
    const ws = await workspaceOf(2);
    const indexPath = join(root, "c.db");
    const embedder = new CountingEmbedder();
    const opts = { workspaceDir: ws, retrievalConfig: CONFIG, embedder, indexPath };

    await indexPendingBatch(opts);
    expect(embedder.documents).toBe(2);

    await writeFile(join(ws, "f000.md"), "something else entirely");
    await utimes(join(ws, "f000.md"), 1000, 1000);

    const after = await indexPendingBatch(opts);
    expect(after.embedded).toBe(1);
    expect(embedder.documents).toBe(3);
  });

  test("a missing workspace is not an error", async () => {
    const out = await indexPendingBatch({
      workspaceDir: join(root, "nope"),
      retrievalConfig: CONFIG,
      embedder: new CountingEmbedder(),
      indexPath: join(root, "d.db"),
    });
    expect(out).toEqual({ embedded: 0, pending: 0, files: 0 });
  });
});

describe("WorkspaceIndexService", () => {
  function serviceAt(now: () => number, options = {}): WorkspaceIndexService {
    return new WorkspaceIndexService({ now, idleDelayMs: 1000, batchPauseMs: 500, ...options });
  }

  test("nothing runs until the daemon has been idle long enough", async () => {
    let clock = 10_000;
    const service = serviceAt(() => clock, { maxBatchItems: 4 });
    const embedder = new CountingEmbedder();
    service.register({
      character: "ada",
      workspaceDir: await workspaceOf(6),
      indexPath: join(root, "idle.db"),
      retrievalConfig: CONFIG,
      embedder,
    });

    await service.runOnce();
    expect(embedder.batches).toBe(0);

    clock += 2000;
    await service.runOnce();
    expect(embedder.documents).toBe(4);
  });

  test("foreground work holds the indexer off and restarts the idle clock", async () => {
    let clock = 10_000;
    const service = serviceAt(() => clock, { maxBatchItems: 4 });
    const embedder = new CountingEmbedder();
    service.register({
      character: "ada",
      workspaceDir: await workspaceOf(6),
      indexPath: join(root, "fg.db"),
      retrievalConfig: CONFIG,
      embedder,
    });

    clock += 2000;
    const end = service.beginForeground();
    await service.runOnce();
    expect(embedder.batches).toBe(0);

    end();
    await service.runOnce();
    expect(embedder.batches).toBe(0);

    clock += 2000;
    await service.runOnce();
    expect(embedder.documents).toBe(4);
  });

  test("a batch pause keeps consecutive rounds off the provider", async () => {
    let clock = 10_000;
    const service = serviceAt(() => clock, { maxBatchItems: 2 });
    const embedder = new CountingEmbedder();
    service.register({
      character: "ada",
      workspaceDir: await workspaceOf(6),
      indexPath: join(root, "pause.db"),
      retrievalConfig: CONFIG,
      embedder,
    });

    clock += 2000;
    await service.runOnce();
    expect(embedder.documents).toBe(2);

    await service.runOnce();
    expect(embedder.documents).toBe(2);

    clock += 600;
    await service.runOnce();
    expect(embedder.documents).toBe(4);
  });

  test("a failure backs off and is reported, not thrown", async () => {
    let clock = 10_000;
    const service = serviceAt(() => clock);
    const embedder = new CountingEmbedder();
    embedder.fail = "provider is down";
    service.register({
      character: "ada",
      workspaceDir: await workspaceOf(3),
      indexPath: join(root, "fail.db"),
      retrievalConfig: CONFIG,
      embedder,
    });

    clock += 2000;
    await service.runOnce();
    const first = service.progress("ada")!;
    expect(first.failures).toBe(1);
    expect(first.lastError).toContain("provider is down");
    expect(first.retryAt).toBeGreaterThan(clock);

    await service.runOnce();
    expect(service.progress("ada")!.failures).toBe(1);

    clock += 70_000;
    await service.runOnce();
    expect(service.progress("ada")!.failures).toBe(2);
  });

  test("progress reports what is left without walking again", async () => {
    let clock = 10_000;
    const service = serviceAt(() => clock, { maxBatchItems: 4 });
    service.register({
      character: "ada",
      workspaceDir: await workspaceOf(10),
      indexPath: join(root, "prog.db"),
      retrievalConfig: CONFIG,
      embedder: new CountingEmbedder(),
    });

    clock += 2000;
    await service.runOnce();

    expect(service.progress("ada")).toMatchObject({
      character: "ada",
      pending: 6,
      files: 10,
      failures: 0,
    });
    expect(service.progress("nobody")).toBeUndefined();
  });

  test("a character with no embedder is registered but never worked", async () => {
    let clock = 10_000;
    const service = serviceAt(() => clock);
    service.register({
      character: "ada",
      workspaceDir: await workspaceOf(3),
      indexPath: join(root, "noembed.db"),
      retrievalConfig: CONFIG,
    });

    clock += 2000;
    await service.runOnce();
    expect(service.registeredCharacters()).toEqual(["ada"]);
    expect(service.progress("ada")!.files).toBe(0);
  });

  test("re-registering with a new embedding model clears the backoff", async () => {
    let clock = 10_000;
    const service = serviceAt(() => clock);
    const failing = new CountingEmbedder();
    failing.fail = "down";
    const registration = {
      character: "ada",
      workspaceDir: await workspaceOf(2),
      indexPath: join(root, "swap.db"),
      retrievalConfig: CONFIG,
    };
    service.register({ ...registration, embedder: failing });

    clock += 2000;
    await service.runOnce();
    expect(service.progress("ada")!.retryAt).toBeGreaterThan(clock);

    const replacement = new CountingEmbedder();
    Object.defineProperty(replacement, "modelId", { value: "topic-v2" });
    service.register({ ...registration, embedder: replacement });

    expect(service.progress("ada")!.retryAt).toBe(0);
    expect(service.progress("ada")!.failures).toBe(0);

    await service.runOnce();
    expect(replacement.documents).toBe(2);
  });

  test("shutdown stops the timer and unregister drops the character", async () => {
    const service = serviceAt(() => 10_000);
    service.register({
      character: "ada",
      workspaceDir: await workspaceOf(1),
      indexPath: join(root, "stop.db"),
      retrievalConfig: CONFIG,
      embedder: new CountingEmbedder(),
    });
    await service.start();
    service.unregister("ada");
    expect(service.registeredCharacters()).toEqual([]);
    await service.shutdown();
    await service.runOnce();
  });
});
