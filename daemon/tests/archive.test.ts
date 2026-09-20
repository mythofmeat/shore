import { writeSession, readBook, bookPathIn, sessionKey, SESSION_BOOK_VERSION } from "../src/llm/providers/agent_sessions.ts";
import { writeDurable, readDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Header } from "tar";

import { exportCharacter, importCharacter, type ArchiveContext } from "../src/commands/archive.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { Ledger } from "../src/ledger/store.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("character archives", () => {
  test("browser archive snapshots and extraction remain inside the owned transfer directory", async () => {
    const source = await root("owned-staging"); await seedCharacter(source, "ada", "archive history");
    const temporaryDirectory = join(source.runtime, "owned-transfer"); await mkdir(temporaryDirectory);
    const limits = { bytes: 1024 * 1024, entries: 100, temporaryDirectory };
    const output = join(temporaryDirectory, "archive.tar.gz");
    let snapshot = false;
    await exportCharacter({ ...context(source, new Set(["ada"])), limits, withSnapshot: async (run) => {
      const result = await run();
      const directory = (await readdir(temporaryDirectory)).find((name) => name.startsWith("shore-export-"));
      expect(directory).toBeDefined();
      expect(await access(join(temporaryDirectory, directory ?? "", "shore.db")).then(() => true, () => false)).toBe(true);
      snapshot = true; return result;
    } }, { character: "ada", output });
    expect(snapshot).toBe(true); expect(await readdir(temporaryDirectory)).toEqual(["archive.tar.gz"]);
    const target = await root("owned-extraction");
    let extracted = false;
    await importCharacter({ ...context(target, new Set()), limits, withSnapshot: async (run) => {
      const directory = (await readdir(temporaryDirectory)).find((name) => name.startsWith("shore-import-"));
      expect(directory).toBeDefined();
      expect(await access(join(temporaryDirectory, directory ?? "", "shore.db")).then(() => true, () => false)).toBe(true);
      extracted = true; return await run();
    } }, { archive: output });
    expect(extracted).toBe(true); expect(await readdir(temporaryDirectory)).toEqual(["archive.tar.gz"]);
  });

  test.each(["../outside", "workspace/../../outside", "unexpected/file", "/absolute/path"])("unsafe archive path %s rejects asynchronously without installing a character", async (path) => {
    const target = await root("unsafe-path");
    const output = join(target.runtime, "unsafe.tar.gz");
    const block = Buffer.alloc(512);
    new Header({ path, size: 1, mode: 0o600, type: "File" }).encode(block);
    await writeFile(output, Bun.gzipSync(Buffer.concat([block, Buffer.from("x"), Buffer.alloc(511 + 1024)])));
    expect(importCharacter(context(target, new Set()), { archive: output })).rejects.toThrow("unexpected path");
    expect(existsSync(join(target.workspace as string, "outside"))).toBe(false);
  });

  test.each([
    { bytes: 8, entries: 100, message: "processing limits" },
    { bytes: 1024 * 1024, entries: 1, message: "processing limits" },
    { bytes: 4096, entries: 100, message: "Database snapshot" },
  ])("browser export budget $bytes bytes/$entries entries rejects before publishing an archive", async (limits) => {
    const source = await root("limited-export"); await seedCharacter(source, "ada", "preserve source");
    const output = join(source.runtime, "limited.tar.gz");
    expect(exportCharacter({ ...context(source, new Set(["ada"])), limits }, { character: "ada", output })).rejects.toThrow(limits.message);
    expect(access(output)).rejects.toThrow();
    expect(await readFile(join(source.workspace as string, "ada", "SOUL.md"), "utf8")).toBe("You are ada.\n");
  });

  test.each([
    { bytes: 128, entries: 100, message: "browser processing limit" },
    { bytes: 1024 * 1024, entries: 1, message: "too many files" },
  ])("browser import budget $bytes bytes/$entries entries rejects before installing data", async (limits) => {
    const source = await root("limited-source"); await seedCharacter(source, "ada", "archive history");
    const output = join(source.runtime, "ada.tar.gz");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });
    const target = await root("limited-target"); await seedCharacter(target, "bea", "preserve other character");
    expect(importCharacter({ ...context(target, new Set(["bea"])), limits }, { archive: output })).rejects.toThrow(limits.message);
    expect(access(join(target.workspace as string, "ada"))).rejects.toThrow();
    const history = HistoryStore.open(join(target.data, "shore.db"));
    try { expect(history.archiveKeys("ada")).toEqual([]); expect(history.readSegment("bea", 0)[0]?.content).toBe("preserve other character"); }
    finally { history.close(); }
  });

  test("browser transfers reject links while native archives preserve their existing link support", async () => {
    const source = await root("link-source"); await seedCharacter(source, "ada", "archive history");
    await symlink("SOUL.md", join(source.workspace as string, "ada", "linked.md"));
    const output = join(source.runtime, "ada.tar.gz");
    const limits = { bytes: 1024 * 1024, entries: 100 };
    expect(exportCharacter({ ...context(source, new Set(["ada"])), limits }, { character: "ada", output })).rejects.toThrow("regular files and directories");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });
    const target = await root("link-target");
    expect(importCharacter({ ...context(target, new Set()), limits }, { archive: output })).rejects.toThrow("unsupported entries");
    expect(access(join(target.workspace as string, "ada"))).rejects.toThrow();
  });

  test("a compressed export restores one character without carrying another", async () => {
    const source = await root("source");
    await seedCharacter(source, "ada", "hello from ada");
    await seedCharacter(source, "bea", "hello from bea");
    const sourceHistory = HistoryStore.open(join(source.data, "shore.db"));
    for (const key of ["ada/side", "ada/retired", "adam/side", "bea/side"]) {
      sourceHistory.putSegment(key, 0, {
        file: "history.db", message_count: 1, compacted_at: "2026-09-05T00:00:00Z",
      }, [userMessage(key, `archived ${key}`)]);
    }
    sourceHistory.close();
    const output = join(source.runtime, "ada.shore.tar.gz");
    const exported = await exportCharacter(context(source, new Set(["ada", "bea"])), {
      character: "ada",
      output,
    }) as Record<string, unknown>;
    expect(exported["bytes"]).toBeGreaterThan(0);

    const target = await root("target");
    let refreshed = false;
    const imported = await importCharacter(
      context(target, new Set(), () => {
        refreshed = true;
      }),
      { archive: output },
    ) as Record<string, unknown>;

    expect(imported["character"]).toBe("ada");
    expect(refreshed).toBe(true);
    expect(await readFile(join(target.workspace as string, "ada", "SOUL.md"), "utf8"))
      .toBe("You are ada.\n");
    expect(await readFile(join(target.data, "ada", "threads", "main", "active.jsonl"), "utf8"))
      .toContain("hello from ada");
    const history = new Database(join(target.data, "shore.db"), { readonly: true });
    expect(history.query("SELECT DISTINCT character FROM history_messages ORDER BY character").values()).toEqual([
      ["ada"], ["ada/retired"], ["ada/side"],
    ]);
    expect(history.query("SELECT character FROM history_segments WHERE character != 'ada' ORDER BY character").values())
      .toEqual([["ada/retired"], ["ada/side"]]);
    history.close();
  });

  test("media and native sessions resume after moving an archive to another data directory", async () => {
    const source = await root("media-source");
    await seedCharacter(source, "ada", "image conversation");
    const oldImage = join(source.data, "media", "ada", "generated", "picture.png");
    await mkdir(join(source.data, "media", "ada", "generated"), { recursive: true });
    await writeFile(oldImage, "original image bytes");
    const active = join(source.data, "ada", "threads", "main", "active.jsonl");
    writeDurable(active, JSON.stringify({ ...userMessage("ada", "image"), images: [oldImage] }) + "\n");
    writeSession(bookPathIn(source.data), sessionKey("ada", join(source.data, "shore.db"), "main"), {
      version: SESSION_BOOK_VERSION, sessionId: "resume-me", entries: [],
    });
    const output = join(source.runtime, "media.shore.tar.gz");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });
    const target = await root("media-target");
    await importCharacter(context(target, new Set()), { archive: output });
    expect(await readFile(join(target.data, "media", "ada", "generated", "picture.png"), "utf8")).toBe("original image bytes");
    expect(readDurable(join(target.data, "ada", "threads", "main", "active.jsonl"))).toContain(join(target.data, "media", "ada"));
    expect(readBook(bookPathIn(target.data))[sessionKey("ada", join(target.data, "shore.db"), "main")]?.sessionId).toBe("resume-me");
  });

  test("import refuses an existing character before changing it", async () => {
    const source = await root("existing-source");
    await seedCharacter(source, "ada", "archive value");
    const output = join(source.runtime, "ada.shore.tar.gz");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });

    const target = await root("existing-target");
    await seedCharacter(target, "ada", "keep me");
    expect(importCharacter(context(target, new Set(["ada"])), { archive: output }))
      .rejects.toThrow("Refusing to overwrite");
    expect(await readFile(join(target.data, "ada", "threads", "main", "active.jsonl"), "utf8")).toContain("keep me");
  });

  test.each(["ada", "ada/retired"])("a hidden history conflict at %s is preserved when import rolls back", async (key) => {
    const source = await root("hidden-source");
    await seedCharacter(source, "ada", "archive value");
    const output = join(source.runtime, "ada.shore.tar.gz");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });

    const target = await root("hidden-target");
    const history = HistoryStore.open(join(target.data, "shore.db"));
    history.putSegment(
      key,
      0,
      { file: "hidden.jsonl", message_count: 1, compacted_at: "2026-09-01T00:00:00Z" },
      [userMessage("ada", "hidden history")],
    );
    history.close();

    expect(importCharacter(context(target, new Set()), { archive: output }))
      .rejects.toThrow("history already exists");
    const preserved = new Database(join(target.data, "shore.db"), { readonly: true });
    const count = preserved
      .query("SELECT COUNT(*) AS count FROM history_messages WHERE character = ?1")
      .get(key) as { count: number };
    expect(count.count).toBe(1);
    preserved.close();
  });
  test("a later import failure removes all imported thread rows and preserves other characters", async () => {
    const source = await root("rollback-source");
    await seedCharacter(source, "ada", "main");
    const store = HistoryStore.open(join(source.data, "shore.db"));
    store.putSegment("ada/retired", 0, {
      file: "history.db", message_count: 1, compacted_at: "2026-09-05T00:00:00Z",
    }, [userMessage("ada", "retired")]);
    store.close();
    const output = join(source.runtime, "ada.shore.tar.gz");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });
    const target = await root("rollback-target");
    await seedCharacter(target, "adam", "preserved");
    expect(importCharacter(context(target, new Set(["adam"]), () => { throw new Error("refresh failed"); }), { archive: output }))
      .rejects.toThrow("refresh failed");
    const restored = HistoryStore.open(join(target.data, "shore.db"));
    expect(restored.archiveKeys("ada")).toEqual([]);
    expect(restored.readSegment("adam", 0)[0]?.content).toBe("preserved");
    restored.close();
  });

});

async function root(name: string): Promise<ShoreDirs> {
  const base = await mkdtemp(join(tmpdir(), `shore-${name}-`));
  roots.push(base);
  const dirs: ShoreDirs = {
    config: join(base, "config"),
    data: join(base, "data"),
    cache: join(base, "cache"),
    runtime: join(base, "runtime"),
    workspace: join(base, "workspace"),
  };
  await Promise.all(Object.values(dirs).map((path) => mkdir(path as string, { recursive: true })));
  Ledger.create(join(dirs.data, "shore.db")).close();
  return dirs;
}

async function seedCharacter(dirs: ShoreDirs, character: string, text: string): Promise<void> {
  const workspace = join(dirs.workspace as string, character);
  const data = join(dirs.data, character);
  await mkdir(workspace, { recursive: true });
  await mkdir(join(data, "threads", "main"), { recursive: true });
  await mkdir(join(dirs.config, "characters", character), { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), `You are ${character}.\n`);
  await writeFile(join(dirs.config, "characters", character, "config.toml"), '[chat]\nmodel = "openai:gpt-test"\n');
  const message = userMessage(character, text);
  writeDurable(join(data, "threads", "main", "active.jsonl"), `${JSON.stringify(message)}\n`);
  const history = HistoryStore.open(join(dirs.data, "shore.db"));
  history.putSegment(
    character,
    0,
    { file: "segment-0.jsonl", message_count: 1, compacted_at: "2026-09-01T00:00:00Z" },
    [message],
  );
  history.close();
}

function userMessage(character: string, content: string): Message {
  return {
    msg_id: `m_${character}`,
    role: "user",
    content,
    content_blocks: [{ type: "text", text: content }],
    images: [],
    timestamp: "2026-09-01T00:00:00Z",
  };
}

function context(
  dirs: ShoreDirs,
  characters: Set<string>,
  refresh: () => void = () => {},
): ArchiveContext {
  return {
    dirs,
    hasCharacter: (name) => characters.has(name),
    withSnapshot: async (run) => await run(),
    refreshDiscovery: async () => {
      refresh();
    },
    releaseCharacter: async () => undefined,
  };
}
