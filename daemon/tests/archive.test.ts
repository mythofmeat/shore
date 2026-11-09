import { writeDurable } from "../src/storage/files.ts";
import { readFile } from "./support/stored_files.ts";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create, extract, Header, Parser } from "tar";

import { deleteCharacter, exportBackup, exportCharacter, importArchive, importCharacter, readTransfer, writeTransfer, type ArchiveContext } from "../src/commands/archive.ts";
import { ArchiveSpool } from "../src/commands/archive_spool.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { Ledger } from "../src/ledger/store.ts";
import { freezeDatabase } from "../src/storage/frozen_database.ts";
import { outcomeOf } from "./support/outcome.ts";
import { StandInWorkspace } from "./support/stand_in_workspace.ts";

describe("character archives", () => {
  test("browser archive snapshots and extraction remain inside the owned transfer directory", async () => {
    const source = await root("owned-staging"); await seedCharacter(source, "ada", "archive history");
    const temporaryDirectory = join(source.runtime, "owned-transfer"); await mkdir(temporaryDirectory);
    const limits = { bytes: 1024 * 1024, entries: 100, temporaryDirectory };
    const output = join(temporaryDirectory, "archive.tar");
    let snapshot = false;
    await exportCharacter({ ...context(source, new Set(["ada"])), limits, withSnapshot: async (run) => {
      const result = await run();
      const directory = (await readdir(temporaryDirectory)).find((name) => name.startsWith("shore-export-"));
      expect(directory).toBeDefined();
      expect(await access(join(temporaryDirectory, directory ?? "", "shore.db")).then(() => true, () => false)).toBe(true);
      snapshot = true; return result;
    } }, { character: "ada", output });
    expect(snapshot).toBe(true); expect(await readdir(temporaryDirectory)).toEqual(["archive.tar"]);
    const target = await root("owned-extraction");
    let extracted = false;
    await importCharacter({ ...context(target, new Set()), limits, withSnapshot: async (run) => {
      const directory = (await readdir(temporaryDirectory)).find((name) => name.startsWith("shore-import-"));
      expect(directory).toBeDefined();
      expect(await access(join(temporaryDirectory, directory ?? "", "shore.db")).then(() => true, () => false)).toBe(true);
      extracted = true; return await run();
    } }, { archive: output });
    expect(extracted).toBe(true); expect(await readdir(temporaryDirectory)).toEqual(["archive.tar"]);
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

  test("a link in an archive can't copy a file from outside the import into the workspace", async () => {
    const source = await root("link-source");
    await seedCharacter(source, "ada", "x");
    const exported = join(source.runtime, "ada.tar");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output: exported });
    const unpacked = await mkdtemp(join(source.runtime, "unpacked-"));
    await extract({ file: exported, cwd: unpacked });
    const secret = join(tmpdir(), `outside-secret-${String(process.pid)}`);
    await writeFile(secret, "secret");
    const blocks: Buffer[] = [];
    for (const path of (await readdir(unpacked, { recursive: true })).sort()) {
      const full = join(unpacked, path);
      const header = Buffer.alloc(512);
      if ((await stat(full)).isDirectory()) {
        new Header({ path: `${path}/`, size: 0, mode: 0o700, type: "Directory" }).encode(header);
        blocks.push(header);
        continue;
      }
      const data = Buffer.from(await Bun.file(full).arrayBuffer());
      new Header({ path, size: data.length, mode: 0o600, type: "File" }).encode(header);
      blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    const link = Buffer.alloc(512);
    new Header({ path: "workspace/stolen.txt", type: "Link", linkpath: `../${String(secret.split("/").at(-1))}`, size: 0, mode: 0o600 }).encode(link);
    const output = join(source.runtime, "linked.tar");
    await writeFile(output, Buffer.concat([...blocks, link, Buffer.alloc(1024)]));
    const target = await root("link-target");
    expect(await outcomeOf(importCharacter(context(target, new Set()), { archive: output }))).toThrow("TAR_ENTRY_ERROR: linkpath contains '..'");
    expect(existsSync(join(target.workspace as string, "ada", "stolen.txt"))).toBe(false);
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
    const output = join(source.runtime, "limited.tar");
    expect(await outcomeOf(exportCharacter({ ...context(source, new Set(["ada"])), limits }, { character: "ada", output }))).toThrow(limits.message);
    expect(await outcomeOf(access(output))).toThrow();
    expect(await readFile(join(source.workspace as string, "ada", "SOUL.md"), "utf8")).toBe("You are ada.\n");
  });

  test.each([
    { bytes: 128, entries: 100, message: "browser processing limit" },
    { bytes: 1024 * 1024, entries: 1, message: "too many files" },
  ])("browser import budget $bytes bytes/$entries entries rejects before installing data", async (limits) => {
    const source = await root("limited-source"); await seedCharacter(source, "ada", "archive history");
    const output = join(source.runtime, "ada.tar");
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
    const output = join(source.runtime, "ada.tar");
    const limits = { bytes: 1024 * 1024, entries: 100 };
    expect(await outcomeOf(exportCharacter({ ...context(source, new Set(["ada"])), limits }, { character: "ada", output }))).toThrow("regular files and directories");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });
    const target = await root("link-target");
    expect(await outcomeOf(importCharacter({ ...context(target, new Set()), limits }, { archive: output }))).toThrow("unsupported entries");
    expect(await outcomeOf(access(join(target.workspace as string, "ada")))).toThrow();
  });

  test("a plain tar export restores one character without carrying another", async () => {
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
    const output = join(source.runtime, "ada.shore.tar");
    const exported = await exportCharacter(context(source, new Set(["ada", "bea"])), {
      character: "ada",
      output,
    }) as Record<string, unknown>;
    expect(exported["bytes"]).toBeGreaterThan(0);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const first = await readFile(output);
    expect(first.subarray(257, 262).toString()).toBe("ustar");
    expect(await outcomeOf(exportCharacter(context(source, new Set(["ada", "bea"])), { character: "ada", output })))
      .toThrow("Refusing to overwrite existing archive");
    expect(await readFile(output)).toEqual(first);
    expect(await outcomeOf(exportCharacter(context(source, new Set(["ada", "bea"])), { character: "cy", output: join(source.runtime, "cy.tar") })))
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
    const output = join(source.runtime, "ada.shore.tar");
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
    const output = join(source.runtime, "ada.shore.tar");
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
    const output = join(source.runtime, "ada.shore.tar");
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

  test("a backup leaves stored provider keys out unless asked, and importing it says so", async () => {
    const source = await root("secrets-source"); await seedCharacter(source, "ada", "ada history");
    await writeFile(join(source.data, "provider_secrets.json"), JSON.stringify({ version: 1, providers: { openrouter: { work: "sk-or-v1-secretvalue1234" } } }), { mode: 0o600 });
    const sending = spooling(source, new Set(["ada"]), 1);
    const plain = await exportBackup(sending);
    const plainTar = await tarEntries(await download(sending, plain.transfer));
    expect(plainTar.has("data/provider_secrets.json")).toBe(false);
    expect([...plainTar.values()].some((bytes) => bytes.toString().includes("sk-or-v1-secretvalue1234"))).toBe(false);
    expect(plain.secrets_left_out).toBe(true);

    const target = await root("secrets-target");
    const receiving = spooling(target, new Set(), 2);
    expect(await importArchive(receiving, { transfer: await uploaded(receiving, plainTar.size === 0 ? Buffer.alloc(0) : await download(sending, (await exportBackup(sending)).transfer)) }))
      .toMatchObject({ characters: ["ada"], secrets_left_out: true });
    expect(existsSync(join(target.data, "provider_secrets.json"))).toBe(false);

    const withKeys = await exportBackup(sending, { include_secrets: true });
    expect(withKeys.secrets_left_out).toBeUndefined();
    const other = await root("secrets-included");
    const restoring = spooling(other, new Set(), 3);
    const imported = await importArchive(restoring, { transfer: await uploaded(restoring, await download(sending, withKeys.transfer)) });
    expect(imported.restored).toContain("data/provider_secrets.json");
    expect(imported.secrets_left_out).toBeUndefined();
    expect((await stat(join(other.data, "provider_secrets.json"))).mode & 0o777).toBe(0o600);
  });

  test("a backup against the previous one's manifest sends only what changed and rebuilds the same database", async () => {
    const source = await root("incremental"); await seedCharacter(source, "ada", "first segment");
    await writeFile(join(source.workspace as string, "ada", "notes.md"), "one\n");
    const padding = new Database(join(source.data, "shore.db"));
    padding.run("CREATE TABLE padding (data BLOB)");
    for (let i = 0; i < 48; i++) padding.query("INSERT INTO padding VALUES (?1)").run(crypto.getRandomValues(new Uint8Array(65536)));
    padding.close();
    const sending = spooling(source, new Set(["ada"]), 1);
    const full = await tarEntries(await download(sending, (await exportBackup(sending)).transfer));
    for (const path of ["workspace/ada/SOUL.md", "workspace/ada/notes.md", "data/shore.db", "manifest.json"]) expect(full.has(path)).toBe(true);

    await writeFile(join(source.workspace as string, "ada", "notes.md"), "two\n");
    const history = HistoryStore.open(join(source.data, "shore.db"));
    history.putSegment("ada", 1, { file: "segment-1.jsonl", message_count: 1, compacted_at: "2026-09-02T00:00:00Z" }, [userMessage("ada", "second segment")]);
    history.close();
    const second = await exportBackup(sending, { base: await uploaded(sending, full.get("manifest.json") ?? Buffer.alloc(0)) });
    const delta = await tarEntries(await download(sending, second.transfer));
    expect([...delta.keys()].filter((path) => !path.startsWith("shore.db.blocks/"))).toEqual(["workspace/ada/notes.md", "manifest.json"]);
    expect(delta.get("workspace/ada/notes.md")?.toString()).toBe("two\n");
    expect(second.files_sent).toBe(1);
    expect(second.blocks_sent).toBeGreaterThan(0);
    expect(second.blocks_sent).toBeLessThan(second.blocks);

    const manifest = JSON.parse((delta.get("manifest.json") ?? "").toString()) as { database: { bytes: number; block_bytes: number } };
    const blocks: Buffer[] = [];
    const whole = full.get("data/shore.db") ?? Buffer.alloc(0);
    for (let offset = 0; offset < manifest.database.bytes; offset += manifest.database.block_bytes) {
      blocks.push(delta.get(`shore.db.blocks/${String(offset)}`) ?? whole.subarray(offset, offset + manifest.database.block_bytes));
    }
    const rebuilt = join(source.runtime, "rebuilt.db");
    await writeFile(rebuilt, Buffer.concat(blocks).subarray(0, manifest.database.bytes));
    const restored = HistoryStore.open(rebuilt);
    try { expect(restored.readSegment("ada", 1)[0]?.content).toBe("second segment"); }
    finally { restored.close(); }
  });

  test("a database snapshot holds still while another connection keeps writing and checkpointing", async () => {
    const dirs = await root("frozen");
    const path = join(dirs.data, "frozen.db");
    const writer = new Database(path);
    writer.run("PRAGMA journal_mode = WAL; CREATE TABLE rows (data BLOB)");
    const insert = writer.query("INSERT INTO rows VALUES (?1)");
    for (let i = 0; i < 200; i++) insert.run(crypto.getRandomValues(new Uint8Array(4096)));
    const frozen = await freezeDatabase(path);
    try {
      for (let i = 0; i < 200; i++) {
        insert.run(crypto.getRandomValues(new Uint8Array(4096)));
        if (i % 20 === 0) writer.run("PRAGMA wal_checkpoint(TRUNCATE)");
      }
      const blocks: Buffer[] = [];
      for await (const block of frozen.blocks(65536)) blocks.push(Buffer.from(block));
      const copy = join(dirs.runtime, "copy.db");
      await writeFile(copy, Buffer.concat(blocks));
      const snapshot = new Database(copy);
      try {
        expect(snapshot.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
        expect(snapshot.query("SELECT count(*) FROM rows").values()).toEqual([[200]]);
      } finally { snapshot.close(); }
    } finally {
      frozen.release();
      writer.close();
    }
  });

  test("a gzipped backup holding gzipped character archives still restores", async () => {
    const source = await root("gzip-backup-source"); await seedCharacter(source, "ada", "ada from a gzipped backup");
    const stage = join(source.runtime, "backup"); await mkdir(join(stage, "characters"), { recursive: true }); await mkdir(join(stage, "config")); await mkdir(join(stage, "data"));
    const inner = join(source.runtime, "ada.shore.tar");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output: inner });
    await writeFile(join(stage, "characters", "ada.shore.tar.gz"), Bun.gzipSync(await readFile(inner)));
    await writeFile(join(stage, "manifest.json"), JSON.stringify({ format: "shore-backup", version: 1, created_at: "2026-10-20T00:00:00Z", characters: ["ada"] }));
    const backup = join(source.runtime, "shore-backup.tar.gz");
    await create({ cwd: stage, file: backup, gzip: true, portable: true }, ["manifest.json", "config", "data", "characters"]);
    const target = await root("gzip-backup-target");
    const receiving = spooling(target, new Set(), 2);
    expect(await importArchive(receiving, { transfer: await uploaded(receiving, await readFile(backup)) }))
      .toEqual({ characters: ["ada"], skipped: [], restored: [], kept: [] });
    const history = HistoryStore.open(join(target.data, "shore.db"));
    try { expect(history.readSegment("ada", 0)[0]?.content).toBe("ada from a gzipped backup"); }
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

async function tarEntries(bytes: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const pending: Promise<void>[] = [];
  const parser = new Parser({
    onReadEntry: (entry) => {
      if (entry.type !== "File") { entry.resume(); return; }
      pending.push(entry.concat().then((data) => { entries.set(entry.path, Buffer.from(data)); }));
    },
  });
  parser.end(bytes);
  await Promise.all(pending);
  return entries;
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

async function packed(dirs: ShoreDirs, files: Record<string, string>): Promise<string> {
  const stage = await mkdtemp(join(dirs.runtime, "stage-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), text);
  }
  const output = join(dirs.runtime, `${String(Object.keys(files).length)}-${String(Date.now())}.tar`);
  await create({ cwd: stage, file: output, portable: true }, [...new Set(Object.keys(files).map((path) => path.split("/")[0] ?? path))]);
  return output;
}

async function archiveEntries(archive: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ onReadEntry: (entry) => { count += 1; bytes += entry.size; entry.resume(); } });
    parser.on("end", resolve);
    parser.on("error", reject);
    void Bun.file(archive).arrayBuffer().then((data) => { parser.end(Buffer.from(data)); });
  });
  return { count, bytes };
}

describe("archive checks", () => {
  test("an archive that isn't a readable Shore character is refused with what is wrong with it", async () => {
    const dirs = await root("manifests");
    const ctx = context(dirs, new Set());
    const manifest = (fields: Record<string, unknown>): string => JSON.stringify({ format: "shore-character", version: 2, character: "ada", source_data: "/srv/data", ...fields });
    const cases: Array<[Record<string, string>, string]> = [
      [{ "workspace/SOUL.md": "x" }, "Not a readable Shore character archive: "],
      [{ "manifest.json": "{not json" }, "Not a readable Shore character archive: "],
      [{ "manifest.json": "[]" }, "Unsupported or malformed Shore character archive"],
      [{ "manifest.json": manifest({ format: "other" }) }, "Unsupported or malformed Shore character archive"],
      [{ "manifest.json": manifest({ version: 1 }) }, "Unsupported or malformed Shore character archive"],
      [{ "manifest.json": manifest({ character: "a/b" }) }, "Archive has an invalid character name"],
      [{ "manifest.json": manifest({ character: 5 }) }, "Archive has an invalid character name"],
      [{ "manifest.json": manifest({}) }, "Archive has no workspace/SOUL.md"],
      [{ "manifest.json": manifest({}), "workspace/SOUL.md": "x" }, "Archive has no shore.db"],
      [{ "manifest.json": manifest({ source_data: "relative" }), "workspace/SOUL.md": "x", "shore.db": "" }, "Archive has an invalid source data directory"],
      [{ "manifest.json": manifest({ source_data: 7 }), "workspace/SOUL.md": "x", "shore.db": "" }, "Archive has an invalid source data directory"],
    ];
    for (const [files, refusal] of cases) {
      const failure = await outcomeOf(importCharacter(ctx, { archive: await packed(dirs, files) }));
      expect(failure).toThrow(refusal);
    }
    expect(existsSync(join(dirs.config, "characters", "ada"))).toBe(false);
  });

  test("a file that isn't a tar archive at all fails as one, before any manifest is looked for", async () => {
    const dirs = await root("not-tar");
    const bogus = join(dirs.runtime, "bogus.tar");
    await writeFile(bogus, "this is not a tar archive at all, just some words that go on long enough to fill a header block".repeat(8));
    let message = "";
    try {
      await importCharacter(context(dirs, new Set()), { archive: bogus });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("Not a readable Shore character archive");
  });

  test("browser limits allow an archive exactly at the entry and byte limits and refuse one entry or byte more", async () => {
    const source = await root("limits-source");
    await seedCharacter(source, "ada", "limits");
    const output = join(source.runtime, "ada.tar");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });
    const { count, bytes } = await archiveEntries(output);
    const attempt = async (limits: { bytes: number; entries: number }) => {
      const target = await root("limits-target");
      return await outcomeOf(importCharacter({ ...context(target, new Set()), limits: { ...limits, temporaryDirectory: target.runtime } }, { archive: output }));
    };
    expect((await attempt({ entries: count, bytes }))()).toMatchObject({ character: "ada", imported: true });
    expect(await attempt({ entries: count - 1, bytes })).toThrow("Browser archive contains unsupported entries or too many files");
    expect(await attempt({ entries: count, bytes: bytes - 1 })).toThrow("Archive expands beyond the browser processing limit");
  });

  test("export won't overwrite an archive, and import names an archive that isn't there", async () => {
    const dirs = await root("refusals");
    await seedCharacter(dirs, "ada", "x");
    const existing = join(dirs.runtime, "taken.tar");
    await writeFile(existing, "already here");
    expect(await outcomeOf(exportCharacter(context(dirs, new Set(["ada"])), { character: "ada", output: existing }))).toThrow(`Refusing to overwrite existing archive: ${existing}`);
    expect(await readFile(existing, "utf8")).toBe("already here");
    const missing = join(dirs.runtime, "missing.tar");
    expect(await outcomeOf(importCharacter(context(dirs, new Set()), { archive: missing }))).toThrow(`Archive not found: ${missing}`);
  });

  test("an imported character brings its pictures and an empty config folder, and a failed import takes them back out", async () => {
    const source = await root("media-source");
    await seedCharacter(source, "ada", "pictures");
    await rm(join(source.config, "characters", "ada", "config.toml"));
    await mkdir(join(source.data, "media", "ada", "sent"), { recursive: true });
    await writeFile(join(source.data, "media", "ada", "sent", "lamp.png"), "png bytes");
    const output = join(source.runtime, "ada.tar");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });

    const target = await root("media-target");
    await importCharacter(context(target, new Set()), { archive: output });
    expect(await readFile(join(target.data, "media", "ada", "sent", "lamp.png"), "utf8")).toBe("png bytes");
    expect(await readdir(join(target.config, "characters", "ada"))).toEqual([]);

    const failing = await root("media-rollback");
    expect(await outcomeOf(importCharacter(context(failing, new Set(), () => { throw new Error("refresh failed"); }), { archive: output }))).toThrow("refresh failed");
    for (const path of [join(failing.data, "media", "ada"), join(failing.cache, "ada"), join(failing.config, "characters", "ada")]) expect(existsSync(path)).toBe(false);
  });
});

describe("a character whose tools run as its own user", () => {
  async function isolatedRoot(name: string) {
    const dirs = await root(name);
    const home = await mkdtemp(join(dirs.runtime, "home-"));
    const workspaces = new Map<string, StandInWorkspace>();
    const workspaceOf = (character: string): StandInWorkspace => {
      const existing = workspaces.get(character);
      if (existing !== undefined) return existing;
      const made = new StandInWorkspace(join(dirs.workspace as string, character), home);
      workspaces.set(character, made);
      return made;
    };
    return { dirs, home, workspaceOf, ctx: (characters: Set<string>, refresh?: () => void): ArchiveContext => ({ ...context(dirs, characters, refresh), workspace: workspaceOf }) };
  }

  test("deleting empties its workspace through its user and removes its workspace history", async () => {
    const { dirs, home, workspaceOf, ctx } = await isolatedRoot("isolated-delete");
    await seedCharacter(dirs, "ada", "x");
    const history = join(home, ".cache", "shore", "workspace-turns", "ada.git");
    await mkdir(history, { recursive: true });
    await writeFile(join(history, "HEAD"), "ref");
    await deleteCharacter(ctx(new Set(["ada"])), { character: "ada", confirm: "ada" });
    expect(existsSync(join(dirs.workspace as string, "ada"))).toBe(false);
    expect(existsSync(history)).toBe(false);
    expect(workspaceOf("ada").calls).toEqual(["clear", "remove"]);
  });

  test("importing fills its existing empty workspace through its user, and refuses a missing or occupied one", async () => {
    const source = await root("isolated-source");
    await seedCharacter(source, "ada", "x");
    const output = join(source.runtime, "ada.tar");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });

    const missing = await isolatedRoot("isolated-missing");
    expect(await outcomeOf(importCharacter(missing.ctx(new Set()), { archive: output }))).toThrow(`${join(missing.dirs.workspace as string, "ada")} does not exist, and ada's tools run as stand-in: create that folder owned by them, then import again`);
    expect(existsSync(join(missing.dirs.config, "characters", "ada"))).toBe(false);

    const occupied = await isolatedRoot("isolated-occupied");
    await mkdir(join(occupied.dirs.workspace as string, "ada"), { recursive: true });
    await writeFile(join(occupied.dirs.workspace as string, "ada", "notes.md"), "mine");
    expect(await outcomeOf(importCharacter(occupied.ctx(new Set()), { archive: output }))).toThrow("Refusing to overwrite existing character 'ada'");
    expect(await readFile(join(occupied.dirs.workspace as string, "ada", "notes.md"), "utf8")).toBe("mine");

    const ready = await isolatedRoot("isolated-ready");
    await mkdir(join(ready.dirs.workspace as string, "ada"), { recursive: true });
    await importCharacter(ready.ctx(new Set()), { archive: output });
    expect(await readFile(join(ready.dirs.workspace as string, "ada", "SOUL.md"), "utf8")).toBe("You are ada.\n");

    const failing = await isolatedRoot("isolated-failing");
    await mkdir(join(failing.dirs.workspace as string, "ada"), { recursive: true });
    expect(await outcomeOf(importCharacter(failing.ctx(new Set(), () => { throw new Error("refresh failed"); }), { archive: output }))).toThrow("refresh failed");
    expect(await readdir(join(failing.dirs.workspace as string, "ada"))).toEqual([]);
    expect(failing.workspaceOf("ada").calls).toEqual(["entries", "clear"]);
  });
});
