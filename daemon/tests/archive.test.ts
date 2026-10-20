import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Header } from "tar";

import { exportBackup, exportCharacter, importArchive, importCharacter, readTransfer, writeTransfer, type ArchiveContext } from "../src/commands/archive.ts";
import { ArchiveSpool } from "../src/commands/archive_spool.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { Ledger } from "../src/ledger/store.ts";
import { outcomeOf } from "./support/outcome.ts";

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
    expect(await outcomeOf(importCharacter(context(target, new Set()), { archive: output }))).toThrow("unexpected path");
    expect(existsSync(join(target.workspace as string, "outside"))).toBe(false);
  });

  test.each(["../evil", "a/b", ""])("an archive naming its character %j is refused", async (character) => {
    const target = await root("bad-name");
    const output = join(target.runtime, "bad-name.tar.gz");
    const manifest = Buffer.from(JSON.stringify({ format: "shore-character", version: 2, character, source_data: "/data" }));
    const header = Buffer.alloc(512);
    new Header({ path: "manifest.json", size: manifest.length, mode: 0o600, type: "File" }).encode(header);
    const padding = Buffer.alloc((512 - (manifest.length % 512)) % 512);
    await writeFile(output, Bun.gzipSync(Buffer.concat([header, manifest, padding, Buffer.alloc(1024)])));
    expect(await outcomeOf(importCharacter(context(target, new Set()), { archive: output }))).toThrow("invalid character name");
    expect(await readdir(join(target.config, "characters")).catch(() => [])).toEqual([]);
  });

  test.each([
    { bytes: 8, entries: 100, message: "processing limits" },
    { bytes: 1024 * 1024, entries: 1, message: "processing limits" },
    { bytes: 4096, entries: 100, message: "Database snapshot" },
  ])("browser export budget $bytes bytes/$entries entries rejects before publishing an archive", async (limits) => {
    const source = await root("limited-export"); await seedCharacter(source, "ada", "preserve source");
    const output = join(source.runtime, "limited.tar.gz");
    expect(await outcomeOf(exportCharacter({ ...context(source, new Set(["ada"])), limits }, { character: "ada", output }))).toThrow(limits.message);
    expect(await outcomeOf(access(output))).toThrow();
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
    expect(await outcomeOf(importCharacter({ ...context(target, new Set(["bea"])), limits }, { archive: output }))).toThrow(limits.message);
    expect(await outcomeOf(access(join(target.workspace as string, "ada")))).toThrow();
    const history = HistoryStore.open(join(target.data, "shore.db"));
    try { expect(history.archiveKeys("ada")).toEqual([]); expect(history.readSegment("bea", 0)[0]?.content).toBe("preserve other character"); }
    finally { history.close(); }
  });

  test("browser transfers reject links while native archives preserve their existing link support", async () => {
    const source = await root("link-source"); await seedCharacter(source, "ada", "archive history");
    await symlink("SOUL.md", join(source.workspace as string, "ada", "linked.md"));
    const output = join(source.runtime, "ada.tar.gz");
    const limits = { bytes: 1024 * 1024, entries: 100 };
    expect(await outcomeOf(exportCharacter({ ...context(source, new Set(["ada"])), limits }, { character: "ada", output }))).toThrow("regular files and directories");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });
    const target = await root("link-target");
    expect(await outcomeOf(importCharacter({ ...context(target, new Set()), limits }, { archive: output }))).toThrow("unsupported entries");
    expect(await outcomeOf(access(join(target.workspace as string, "ada")))).toThrow();
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
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const first = await readFile(output);
    expect(await outcomeOf(exportCharacter(context(source, new Set(["ada", "bea"])), { character: "ada", output })))
      .toThrow("Refusing to overwrite existing archive");
    expect(await readFile(output)).toEqual(first);
    expect(await outcomeOf(exportCharacter(context(source, new Set(["ada", "bea"])), { character: "cy", output: join(source.runtime, "cy.tar.gz") })))
      .toThrow("Character not found");

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

  test("import refuses an existing character before changing it", async () => {
    const source = await root("existing-source");
    await seedCharacter(source, "ada", "archive value");
    const output = join(source.runtime, "ada.shore.tar.gz");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });

    const target = await root("existing-target");
    await seedCharacter(target, "ada", "keep me");
    expect(await outcomeOf(importCharacter(context(target, new Set(["ada"])), { archive: output })))
      .toThrow("Refusing to overwrite");
    expect(await readFile(join(target.data, "ada", "threads", "main", "active.jsonl"), "utf8")).toContain("keep me");
  });
  test("import refuses to land on anything a character left behind, even one no longer listed", async () => {
    const source = await root("leftover-source");
    await seedCharacter(source, "ada", "archive value");
    const output = join(source.runtime, "ada.shore.tar.gz");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });

    for (const leftover of ["workspace", "data", "config"] as const) {
      const target = await root(`leftover-${leftover}`);
      const path = leftover === "workspace" ? join(target.workspace as string, "ada")
        : leftover === "data" ? join(target.data, "ada") : join(target.config, "characters", "ada");
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "notes.md"), "keep me\n");
      expect(await outcomeOf(importCharacter(context(target, new Set()), { archive: output }))).toThrow("Refusing to overwrite");
      expect(await readFile(join(path, "notes.md"), "utf8")).toBe("keep me\n");
    }
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
    expect(await outcomeOf(importCharacter(context(target, new Set(["adam"]), () => { throw new Error("refresh failed"); }), { archive: output })))
      .toThrow("refresh failed");
    for (const path of [join(target.config, "characters", "ada"), join(target.workspace as string, "ada"), join(target.data, "ada")]) {
      expect(existsSync(path)).toBe(false);
    }
    const restored = HistoryStore.open(join(target.data, "shore.db"));
    expect(restored.archiveKeys("ada")).toEqual([]);
    expect(restored.readSegment("adam", 0)[0]?.content).toBe("preserved");
    restored.close();
  });

  test("a download spooled for one connection travels in chunks and lands through another's upload", async () => {
    const source = await root("spooled-source"); await seedCharacter(source, "ada", "spooled history");
    const sending = spooling(source, new Set(["ada"]), 1);
    const exported = await exportCharacter(sending, { character: "ada" });
    if (exported.transfer === undefined) throw new Error("A spooled export names its transfer");
    expect(await outcomeOf(readTransfer({ ...sending, owner: 2 }, { transfer: exported.transfer, offset: 0 }))).toThrow("No download transfer");
    const bytes = await download(sending, exported.transfer);
    expect(bytes.length).toBe(exported.bytes);
    expect(bytes.length).toBeGreaterThan(4096);
    expect(await outcomeOf(readTransfer(sending, { transfer: exported.transfer, offset: 0 }))).toThrow("No download transfer");

    const target = await root("spooled-target");
    const receiving = spooling(target, new Set(), 3);
    expect(await importArchive(receiving, { transfer: await uploaded(receiving, bytes) }))
      .toEqual({ characters: ["ada"], skipped: [], restored: [], kept: [] });
    expect(await readFile(join(target.workspace as string, "ada", "SOUL.md"), "utf8")).toBe("You are ada.\n");
    expect(await readdir(join(target.cache, "archive-transfers"))).toEqual([]);
  });

  test("a backup restores every missing character and global file and leaves what exists alone", async () => {
    const source = await root("backup-source");
    await seedCharacter(source, "ada", "ada history"); await seedCharacter(source, "bea", "bea in the backup");
    await mkdir(join(source.config, "prompts")); await writeFile(join(source.config, "prompts", "style.md"), "be brief\n");
    await writeFile(join(source.config, "config.toml"), "[chat]\nmodel = \"openai:from-backup\"\n");
    await mkdir(join(source.data, "preferences")); await writeFile(join(source.data, "preferences", "models.toml"), "favorites = []\n");
    const sending = spooling(source, new Set(["ada", "bea"]), 1);
    const backup = await exportBackup(sending);
    expect(backup.characters).toEqual(["ada", "bea"]);

    const target = await root("backup-target"); await seedCharacter(target, "bea", "bea already here");
    await writeFile(join(target.config, "config.toml"), "[chat]\nmodel = \"openai:kept\"\n");
    const receiving = spooling(target, new Set(["bea"]), 2);
    expect(await importArchive(receiving, { transfer: await uploaded(receiving, await download(sending, backup.transfer)) })).toEqual({
      characters: ["ada"], skipped: ["bea"], restored: ["config/prompts/style.md", "data/preferences/models.toml"], kept: ["config/config.toml"],
    });
    expect(await readFile(join(target.config, "config.toml"), "utf8")).toContain("openai:kept");
    expect(await readFile(join(target.config, "prompts", "style.md"), "utf8")).toBe("be brief\n");
    expect(await readFile(join(target.config, "characters", "ada", "config.toml"), "utf8")).toContain("openai:gpt-test");
    expect(await readFile(join(target.data, "bea", "threads", "main", "active.jsonl"), "utf8")).toContain("bea already here");
    const history = HistoryStore.open(join(target.data, "shore.db"));
    try { expect(history.readSegment("ada", 0)[0]?.content).toBe("ada history"); expect(history.readSegment("bea", 0)[0]?.content).toBe("bea already here"); }
    finally { history.close(); }
  });

  test("transfers whose connection is gone are removed", async () => {
    const dirs = await root("swept"); await seedCharacter(dirs, "ada", "history");
    let connected = true;
    const spool = new ArchiveSpool(join(dirs.cache, "archive-transfers"), () => connected);
    const ctx = { ...context(dirs, new Set(["ada"])), spool, owner: 1 };
    await exportCharacter(ctx, { character: "ada" });
    const upload = await writeTransfer(ctx, { data: Buffer.from("partial").toString("base64") });
    expect(await readdir(join(dirs.cache, "archive-transfers"))).toHaveLength(2);
    await spool.sweep();
    expect(await readdir(join(dirs.cache, "archive-transfers"))).toHaveLength(2);
    connected = false;
    await spool.sweep();
    expect(await readdir(join(dirs.cache, "archive-transfers"))).toEqual([]);
    expect(await outcomeOf(importArchive(ctx, { transfer: upload.transfer }))).toThrow("No upload transfer");
  });
});

function spooling(dirs: ShoreDirs, characters: Set<string>, owner: number): ArchiveContext {
  return { ...context(dirs, characters), spool: new ArchiveSpool(join(dirs.cache, "archive-transfers"), () => true, 4096), owner };
}

async function download(ctx: ArchiveContext, transfer: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (let offset = 0, total = 1; offset < total;) {
    const chunk = await readTransfer(ctx, { transfer, offset });
    const bytes = Buffer.from(chunk.data, "base64");
    parts.push(bytes); offset += bytes.length; total = chunk.bytes;
  }
  return Buffer.concat(parts);
}

async function uploaded(ctx: ArchiveContext, bytes: Buffer): Promise<string> {
  let transfer: string | undefined;
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const data = bytes.subarray(offset, offset + 4096).toString("base64");
    transfer = (await writeTransfer(ctx, transfer === undefined ? { data } : { transfer, data })).transfer;
  }
  if (transfer === undefined) throw new Error("Nothing to upload");
  return transfer;
}

async function root(name: string): Promise<ShoreDirs> {
  const base = await mkdtemp(join(tmpdir(), `shore-${name}-`));
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
    characters: () => [...characters],
    hasCharacter: (name) => characters.has(name),
    withSnapshot: async (run) => await run(),
    refreshDiscovery: async () => {
      refresh();
    },
    releaseCharacter: async () => undefined,
  };
}
