import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Parser, type ReadEntry } from "tar";

import type { ShoreDirs } from "../config/dirs.ts";
import { characterWorkspaceDir, isUsableCharacterName } from "../config/dirs.ts";
import { DATA_DIRECTORY_LEASE_FILE, DATA_DIRECTORY_LOCK_FILE } from "../daemon/data_directory_lease.ts";
import { freezeDatabase, type FrozenDatabase } from "../storage/frozen_database.ts";
import { attachmentCacheDir } from "../storage/image_cache.ts";
import { imageBlobDir } from "../storage/image_blobs.ts";
import { databasePath, openStorage } from "../storage/store.ts";
import type { TarWriter } from "../storage/tar_writer.ts";
import type { CharacterWorkspace } from "../tools/character_workspace.ts";
import { indexTree, type IndexedEntry } from "../tools/tree_index.ts";
import { CommandError, invalidRequest } from "./errors.ts";

export const BACKUP_FORMAT = "shore-backup";
export const TREE_VERSION = 2;
export const TREE_TOP_LEVEL = ["manifest.json", "config", "data", "workspace", "cache"];
export const DATABASE_ENTRY = "data/shore.db";
const DATABASE_BLOCKS = "shore.db.blocks";
const DATABASE_BLOCK_BYTES = 16 * 1024;
const READ_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

type FileEntry = Extract<IndexedEntry, { kind: "file" }>;

export interface TreeManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof TREE_VERSION;
  created_at: string;
  characters: string[];
  source: { data: string; cache: string };
  entries: IndexedEntry[];
  database: { bytes: number; block_bytes: number; blocks: string[] };
}

export interface TreeCapture {
  characters: string[];
  files: number;
  files_sent: number;
  blocks: number;
  blocks_sent: number;
}

export interface TreeSources {
  readonly dirs: ShoreDirs;
  readonly characters: readonly string[];
  isolated(character: string): CharacterWorkspace | undefined;
  withSnapshot<T>(run: () => Promise<T>): Promise<T>;
}

interface Source {
  prefix: string;
  root: string;
  skip: string[];
  workspace?: CharacterWorkspace | undefined;
}

export async function captureTree(sources: TreeSources, writer: TarWriter, base?: TreeManifest): Promise<TreeCapture> {
  const { dirs } = sources;
  const characters = [...sources.characters].sort();
  const path = databasePath(dirs.data);
  if (!existsSync(path)) openStorage(dirs.data).close();
  const previous = new Map<string, FileEntry>();
  for (const entry of base?.entries ?? []) if (entry.kind === "file") previous.set(entry.path, entry);
  const entries: IndexedEntry[] = [];
  let database: FrozenDatabase | undefined;
  let sent = 0;
  try {
    const { createdAt, frozen } = await sources.withSnapshot(async () => {
      const held = await freezeDatabase(path);
      database = held;
      const frozenAt = new Date();
      for (const source of treeSources(dirs, characters, (character) => sources.isolated(character))) {
        const found = source.workspace === undefined
          ? await indexTree(source.root, source.skip)
          : await source.workspace.call("index", { root: source.root });
        if (found === null) continue;
        const prefixed = found.map((entry) => ({ ...entry, path: entry.path === "" ? source.prefix : `${source.prefix}/${entry.path}` }));
        entries.push(...prefixed);
        if (base === undefined) {
          for (const entry of prefixed) {
            if (entry.kind === "directory") await writer.directory(entry.path, entry.mode);
            else if (entry.kind === "symlink") await writer.symlink(entry.path, entry.target);
          }
        }
        const changed = prefixed.filter((entry): entry is FileEntry => entry.kind === "file" && !unchanged(entry, previous.get(entry.path)));
        if (source.workspace === undefined) {
          for (const file of changed) await addLocalFile(writer, join(source.root, file.path.slice(source.prefix.length + 1)), file);
        } else {
          await addWorkspaceFiles(writer, source.workspace, source.prefix, changed);
        }
        sent += changed.length;
      }
      return { createdAt: frozenAt, frozen: held };
    });
    const blocks: string[] = [];
    const reuse = base?.database.block_bytes === DATABASE_BLOCK_BYTES ? base.database.blocks : undefined;
    let blocksSent = 0;
    if (reuse === undefined) {
      await writer.add({ path: DATABASE_ENTRY, size: frozen.bytes, mode: 0o600, mtime: createdAt }, hashed(frozen.blocks(DATABASE_BLOCK_BYTES), blocks));
      blocksSent = blocks.length;
    } else {
      for await (const block of frozen.blocks(DATABASE_BLOCK_BYTES)) {
        const index = blocks.length;
        blocks.push(blockHash(block));
        if (reuse[index] === blocks[index]) continue;
        await writer.add({ path: `${DATABASE_BLOCKS}/${String(index * DATABASE_BLOCK_BYTES)}`, size: block.length, mode: 0o600, mtime: createdAt }, [block]);
        blocksSent += 1;
      }
    }
    const manifest: TreeManifest = {
      format: BACKUP_FORMAT,
      version: TREE_VERSION,
      created_at: createdAt.toISOString(),
      characters,
      source: { data: resolve(dirs.data), cache: resolve(dirs.cache) },
      entries,
      database: { bytes: frozen.bytes, block_bytes: DATABASE_BLOCK_BYTES, blocks },
    };
    const text = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    await writer.add({ path: "manifest.json", size: text.length, mode: 0o600, mtime: createdAt }, [text]);
    return {
      characters,
      files: entries.filter((entry) => entry.kind === "file").length,
      files_sent: sent,
      blocks: blocks.length,
      blocks_sent: blocksSent,
    };
  } finally {
    database?.release();
  }
}

function treeSources(dirs: ShoreDirs, characters: readonly string[], isolated: (character: string) => CharacterWorkspace | undefined): Source[] {
  const workspaces = characters.map((name) => ({ name, root: resolve(characterWorkspaceDir(dirs.config, name, dirs.workspace)) }));
  const roots = [dirs.config, dirs.data, dirs.cache, dirs.runtime, dirs.workspace]
    .filter((root): root is string => root !== undefined)
    .map((root) => resolve(root));
  const nested = (root: string) => [...roots, ...workspaces.map((workspace) => workspace.root)]
    .filter((path) => path !== root && path.startsWith(`${root}/`));
  const config = resolve(dirs.config);
  const data = resolve(dirs.data);
  const live = ["shore.db", "shore.db-wal", "shore.db-shm", "shore.db-journal", DATA_DIRECTORY_LEASE_FILE, DATA_DIRECTORY_LOCK_FILE, `${DATA_DIRECTORY_LOCK_FILE}-journal`];
  return [
    { prefix: "config", root: config, skip: nested(config) },
    { prefix: "data", root: data, skip: [...nested(data), ...live.map((name) => join(data, name))] },
    ...workspaces.map((workspace) => ({ prefix: `workspace/${workspace.name}`, root: workspace.root, skip: [], workspace: isolated(workspace.name) })),
    ...characters.flatMap((name) => [
      { prefix: `cache/characters/${name}/images/blobs`, root: resolve(imageBlobDir(dirs.cache, name)), skip: [] },
      { prefix: `cache/characters/${name}/images/attachments`, root: resolve(attachmentCacheDir(dirs.cache, name)), skip: [] },
    ]),
  ];
}

function unchanged(entry: FileEntry, previous: FileEntry | undefined): boolean {
  return previous !== undefined && previous.size === entry.size && previous.mtime === entry.mtime && previous.mode === entry.mode;
}

function modified(file: FileEntry): Date {
  return new Date(Number(BigInt(file.mtime) / 1_000_000n));
}

function changedWhileReading(path: string): CommandError {
  return invalidRequest(`${path} changed while it was being backed up; run the backup again`);
}

async function addLocalFile(writer: TarWriter, absolute: string, file: FileEntry): Promise<void> {
  const handle = await open(absolute, "r");
  try {
    const same = async () => {
      const info = await handle.stat({ bigint: true });
      return Number(info.size) === file.size && info.mtimeNs.toString() === file.mtime;
    };
    if (!await same()) throw changedWhileReading(file.path);
    await writer.add({ path: file.path, size: file.size, mode: file.mode, mtime: modified(file) }, (async function* () {
      for (let offset = 0; offset < file.size;) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_BYTES, file.size - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) return;
        offset += bytesRead;
        yield bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
      }
    })());
    if (!await same()) throw changedWhileReading(file.path);
  } finally {
    await handle.close();
  }
}

async function addWorkspaceFiles(writer: TarWriter, workspace: CharacterWorkspace, prefix: string, files: readonly FileEntry[]): Promise<void> {
  if (files.length === 0) return;
  const wanted = new Map(files.map((file) => [file.path.slice(prefix.length + 1), file]));
  const child = await workspace.spawn("tar", ["--create", "--file=-", `--directory=${workspace.dir}`, "--no-recursion", "--null", "--files-from=-"], { cwd: workspace.dir });
  child.stdin.end([...wanted.keys()].map((path) => `${path}\0`).join(""));
  let failure: unknown;
  let queue = Promise.resolve();
  const parser = new Parser({
    strict: true,
    noResume: true,
    onReadEntry: (entry: ReadEntry) => {
      queue = queue.then(async () => {
        if (failure !== undefined) {
          entry.resume();
          return;
        }
        try {
          const relative = entry.path.replace(/^\.\//, "");
          const file = wanted.get(relative);
          if (file === undefined || !["File", "OldFile"].includes(entry.type) || entry.size !== file.size) throw changedWhileReading(`${prefix}/${relative}`);
          wanted.delete(relative);
          await writer.add({ path: file.path, size: file.size, mode: file.mode, mtime: modified(file) }, entry);
        } catch (error) {
          failure = error;
          entry.resume();
          child.kill();
        }
      });
    },
  });
  try {
    await finished(child, pipeline(child.stdout, parser).then(async () => await queue), `could not read ${workspace.dir} as ${workspace.tools.user ?? "the character"}`);
  } catch (error) {
    throw failure ?? error;
  }
  if (failure !== undefined) throw failure;
  const missing = [...wanted.values()][0];
  if (missing !== undefined) throw changedWhileReading(missing.path);
}

export async function finished(child: ChildProcessWithoutNullStreams, transfer: Promise<void>, what: string): Promise<void> {
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
  const exited = once(child, "close") as Promise<[number | null]>;
  exited.catch(() => {});
  const moved = await transfer.then(() => undefined, (error: unknown) => error);
  const [code] = await exited;
  if (moved instanceof CommandError) throw moved;
  if (code !== 0) throw new Error(`${what}: tar exited with ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`);
  if (moved !== undefined) throw moved;
}

async function* hashed(blocks: AsyncIterable<Buffer>, hashes: string[]): AsyncGenerator<Buffer> {
  for await (const block of blocks) {
    hashes.push(blockHash(block));
    yield block;
  }
}

function blockHash(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 32);
}

export async function readTreeManifest(path: string): Promise<TreeManifest> {
  if ((await stat(path)).size > MAX_MANIFEST_BYTES) throw invalidRequest("The previous backup's manifest is too large");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw invalidRequest("The previous backup's manifest is not JSON");
  }
  const manifest = treeManifest(value);
  if (manifest === undefined) throw invalidRequest("The previous backup's manifest is not a Shore backup manifest");
  return manifest;
}

export function treeManifest(value: unknown): TreeManifest | undefined {
  if (!isRecord(value) || value["format"] !== BACKUP_FORMAT || value["version"] !== TREE_VERSION) return undefined;
  const { characters, source, entries, database } = value;
  if (
    typeof value["created_at"] !== "string" ||
    !Array.isArray(characters) || !characters.every((name) => typeof name === "string" && isUsableCharacterName(name)) ||
    new Set(characters).size !== characters.length ||
    !isRecord(source) || typeof source["data"] !== "string" || typeof source["cache"] !== "string" ||
    !Array.isArray(entries) || !entries.every(isEntry) ||
    !isRecord(database) || !Number.isSafeInteger(database["bytes"]) || !Number.isSafeInteger(database["block_bytes"]) ||
    !Array.isArray(database["blocks"]) || !database["blocks"].every((hash) => typeof hash === "string" && /^[0-9a-f]{32,64}$/.test(hash))
  ) {
    throw invalidRequest("Malformed Shore backup manifest");
  }
  return value as unknown as TreeManifest;
}

function isEntry(value: unknown): value is IndexedEntry {
  if (!isRecord(value) || typeof value["path"] !== "string") return false;
  switch (value["kind"]) {
    case "file":
      return Number.isSafeInteger(value["mode"]) && Number.isSafeInteger(value["size"]) && typeof value["mtime"] === "string" && /^\d+$/.test(value["mtime"]);
    case "directory":
      return Number.isSafeInteger(value["mode"]);
    case "symlink":
      return typeof value["target"] === "string";
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
