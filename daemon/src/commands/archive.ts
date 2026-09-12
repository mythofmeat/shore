import { exportUnifiedDatabase, importUnifiedDatabase, removeStoredCharacter } from "../storage/archive.ts";
import { databasePath } from "../storage/store.ts";
import { characterMediaDir } from "../storage/media.ts";
import { chmod, cp, link, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { create, extract } from "tar";

import type { ShoreDirs } from "../config/dirs.ts";
import {
  SOUL_FILE,
  characterCacheDir,
  characterConfigDir,
  characterDataDir,
  characterWorkspaceDir,
  isUsableCharacterName,
} from "../config/dirs.ts";
import { invalidRequest, notFound } from "./errors.ts";
import type { Args } from "./navigation.ts";
import type { ExportCharacterResult } from "../protocol/ExportCharacterResult.ts";
import type { ImportCharacterResult } from "../protocol/ImportCharacterResult.ts";
import type { DeleteCharacterResult } from "../protocol/DeleteCharacterResult.ts";
import {
  importHistoryDatabase,
  importLedgerDatabase,
  removeCharacterDatabaseRows,
} from "./archive_databases.ts";

const FORMAT = "shore-character";
const VERSION = 2;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const TOP_LEVEL = new Set(["manifest.json", "config", "workspace", "data", "history.db", "ledger.db", "shore.db", "media"]);

export interface ArchiveContext {
  readonly dirs: ShoreDirs;
  hasCharacter(name: string): boolean;
  withSnapshot<T>(run: () => Promise<T>): Promise<T>;
  refreshDiscovery(): Promise<void>;
  releaseCharacter(name: string): Promise<void>;
}

interface Manifest {
  format: typeof FORMAT;
  version: 1 | 2;
  source_data?: string;
  character: string;
  created_at: string;
  contents: {
    config: boolean;
    workspace: true;
    data: boolean;
    history: true;
    ledger: true;
    call_diagnostics: boolean;
    external_memory_bank: false;
  };
}

export async function exportCharacter(ctx: ArchiveContext, args: Args): Promise<ExportCharacterResult> {
  const character = requiredCharacter(args["character"]);
  if (!ctx.hasCharacter(character)) throw notFound(`Character not found: ${character}`);
  const output = requiredAbsolutePath(args["output"], "output");
  if (await exists(output)) throw invalidRequest(`Refusing to overwrite existing archive: ${output}`);
  if (!await exists(dirname(output))) throw invalidRequest(`Archive directory does not exist: ${dirname(output)}`);

  const stage = await mkdtemp(join(tmpdir(), "shore-export-"));
  const temporaryOutput = join(
    dirname(output),
    `.${basename(output)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await ctx.withSnapshot(async () => {
      await stageCharacter(ctx.dirs, character, stage);
    });
    await create(
      {
        cwd: stage,
        file: temporaryOutput,
        gzip: true,
        portable: true,
        noMtime: false,
        strict: true,
      },
      ["manifest.json", "config", "workspace", "data", "shore.db", "media"],
    );
    await chmod(temporaryOutput, 0o600);
    try {
      await link(temporaryOutput, output);
    } catch (error) {
      if (await exists(output)) {
        throw invalidRequest(`Refusing to overwrite existing archive: ${output}`);
      }
      throw error;
    }
    const size = (await stat(output)).size;
    return {
      character,
      archive: output,
      bytes: size,
      live: true,
      call_diagnostics: "included",
      external_memory: "rebuild_from_archived_segments",
    };
  } finally {
    await unlink(temporaryOutput).catch(() => {});
    await rm(stage, { recursive: true, force: true });
  }
}

export async function importCharacter(ctx: ArchiveContext, args: Args): Promise<ImportCharacterResult> {
  const archive = requiredAbsolutePath(args["archive"], "archive");
  if (!await exists(archive)) throw notFound(`Archive not found: ${archive}`);
  const stage = await mkdtemp(join(tmpdir(), "shore-import-"));
  try {
    await extractArchive(archive, stage);
    const manifest = await readManifest(stage);
    const character = manifest.character;
    await ctx.withSnapshot(async () => {
      await installCharacter(ctx, stage, character);
    });
    return {
      character,
      archive,
      imported: true,
      external_memory: "queued_for_rebuild_when_retain_is_enabled",
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function deleteCharacter(ctx: ArchiveContext, args: Args): Promise<DeleteCharacterResult> {
  const character = requiredCharacter(args["character"]);
  if (args["confirm"] !== character) {
    throw invalidRequest(
      `Deleting a character cannot be undone: repeat the name as confirm to delete ${character}`,
    );
  }

  const targets = deletionTargets(ctx.dirs, character);
  const present: string[] = [];
  for (const path of targets) if (await exists(path)) present.push(path);
  if (!ctx.hasCharacter(character) && present.length === 0) {
    throw notFound(`Character not found: ${character}`);
  }

  const backup = args["archive"];
  let archived: string | undefined;
  if (backup !== undefined) {
    const written = await exportCharacter(ctx, { character, output: backup });
    archived = written.archive;
  }

  const historyPath = databasePath(ctx.dirs.data);
  const ledgerPath = databasePath(ctx.dirs.data);
  await ctx.withSnapshot(async () => {
    await ctx.releaseCharacter(character);
    for (const path of present) await rm(path, { recursive: true, force: true });
    if (await exists(historyPath)) removeStoredCharacter(historyPath, character);
    removeCharacterDatabaseRows(historyPath, ledgerPath, character, {
      history: await exists(historyPath),
      ledger: await exists(ledgerPath),
    });
    await ctx.refreshDiscovery();
  });

  return {
    character,
    deleted: true,
    removed: present,
    archive: archived ?? null,
  };
}

function deletionTargets(dirs: ShoreDirs, character: string): string[] {
  const paths = [
    characterWorkspaceDir(dirs.config, character, dirs.workspace),
    characterConfigDir(dirs.config, character),
    characterDataDir(dirs.data, character),
    characterCacheDir(dirs.cache, character),
    characterMediaDir(dirs.data, character),
  ];
  return paths.filter(
    (path, index) =>
      paths.indexOf(path) === index &&
      !paths.some((other, otherIndex) => otherIndex !== index && contains(other, path)),
  );
}

function contains(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

async function stageCharacter(dirs: ShoreDirs, character: string, stage: string): Promise<void> {
  const configSource = characterConfigDir(dirs.config, character);
  const workspaceSource = characterWorkspaceDir(dirs.config, character, dirs.workspace);
  const dataSource = characterDataDir(dirs.data, character);
  const workspaceInConfig = dirs.workspace === undefined;

  if (!await exists(join(workspaceSource, SOUL_FILE))) {
    throw invalidRequest(`Character definition disappeared during export: ${workspaceSource}`);
  }
  if (await exists(configSource)) {
    const excluded = resolve(configSource, "workspace");
    await cp(configSource, join(stage, "config"), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (source) => !workspaceInConfig || resolve(source) !== excluded,
    });
  } else {
    await mkdir(join(stage, "config"));
  }
  await cp(workspaceSource, join(stage, "workspace"), {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  if (await exists(dataSource)) {
    await cp(dataSource, join(stage, "data"), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  } else {
    await mkdir(join(stage, "data"));
  }

  const media = characterMediaDir(dirs.data, character);
  if (await exists(media)) await cp(media, join(stage, "media"), copyOptions());
  else await mkdir(join(stage, "media"));
  exportUnifiedDatabase(databasePath(dirs.data), character, join(stage, "shore.db"));
  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    source_data: dirs.data,
    character,
    created_at: new Date().toISOString(),
    contents: {
      config: await hasEntries(join(stage, "config")),
      workspace: true,
      data: await hasEntries(join(stage, "data")),
      history: true,
      ledger: true,
      call_diagnostics: true,
      external_memory_bank: false,
    },
  };
  await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function extractArchive(archive: string, stage: string): Promise<void> {
  let total = 0;
  await extract({
    cwd: stage,
    file: archive,
    gzip: true,
    preservePaths: false,
    strict: true,
    filter: (path, entry) => {
      const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
      const top = normalized.split("/")[0] ?? "";
      if (!TOP_LEVEL.has(top) || isAbsolute(path) || normalized.split("/").includes("..")) {
        throw invalidRequest(`Archive contains an unexpected path: ${path}`);
      }
      total += entry.size;
      if (total > MAX_EXTRACTED_BYTES) throw invalidRequest("Archive expands beyond 4 TiB");
      return true;
    },
  });
}

async function readManifest(stage: string): Promise<Manifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(stage, "manifest.json"), "utf8"));
  } catch (error) {
    throw invalidRequest(`Not a readable Shore character archive: ${String(error)}`);
  }
  if (!isRecord(value) || value["format"] !== FORMAT || (value["version"] !== 1 && value["version"] !== VERSION)) {
    throw invalidRequest("Unsupported or malformed Shore character archive");
  }
  const character = value["character"];
  if (typeof character !== "string" || !isUsableCharacterName(character)) {
    throw invalidRequest("Archive has an invalid character name");
  }
  if (!await exists(join(stage, "workspace", SOUL_FILE))) {
    throw invalidRequest(`Archive has no workspace/${SOUL_FILE}`);
  }
  for (const file of value["version"] === 1 ? ["history.db", "ledger.db"] : ["shore.db"]) {
    if (!await exists(join(stage, file))) throw invalidRequest(`Archive has no ${file}`);
  }
  if (value["version"] === 2 && (typeof value["source_data"] !== "string" || !isAbsolute(value["source_data"]))) {
    throw invalidRequest("Archive has an invalid source data directory");
  }
  return value as unknown as Manifest;
}

async function installCharacter(ctx: ArchiveContext, stage: string, character: string): Promise<void> {
  const configTarget = characterConfigDir(ctx.dirs.config, character);
  const workspaceTarget = characterWorkspaceDir(ctx.dirs.config, character, ctx.dirs.workspace);
  const dataTarget = characterDataDir(ctx.dirs.data, character);
  const occupied = [configTarget, workspaceTarget, dataTarget, characterMediaDir(ctx.dirs.data, character)].filter((path, index, all) =>
    all.indexOf(path) === index,
  );
  if (ctx.hasCharacter(character) || (await Promise.all(occupied.map(exists))).some(Boolean)) {
    throw invalidRequest(`Refusing to overwrite existing character '${character}'`);
  }

  const historyPath = databasePath(ctx.dirs.data);
  const ledgerPath = databasePath(ctx.dirs.data);
  const created: string[] = [];
  const imported = { history: false, ledger: false };
  try {
    await mkdir(dirname(configTarget), { recursive: true });
    if (await hasEntries(join(stage, "config"))) {
      await cp(join(stage, "config"), configTarget, copyOptions());
      created.push(configTarget);
    } else {
      await mkdir(configTarget);
      created.push(configTarget);
    }
    await mkdir(dirname(workspaceTarget), { recursive: true });
    await cp(join(stage, "workspace"), workspaceTarget, copyOptions());
    if (!created.includes(workspaceTarget)) created.push(workspaceTarget);
    await mkdir(dirname(dataTarget), { recursive: true });
    await cp(join(stage, "data"), dataTarget, copyOptions());
    created.push(dataTarget);

    if (await exists(join(stage, "shore.db"))) {
      const manifest = await readManifest(stage);
      importUnifiedDatabase(historyPath, join(stage, "shore.db"), character, manifest.source_data, ctx.dirs.data);
      imported.history = true;
      imported.ledger = true;
      const media = characterMediaDir(ctx.dirs.data, character);
      if (await exists(join(stage, "media"))) {
        await mkdir(dirname(media), { recursive: true });
        await cp(join(stage, "media"), media, copyOptions());
        created.push(media);
      }
    } else {
      importHistoryDatabase(historyPath, join(stage, "history.db"), character);
      imported.history = true;
      importLedgerDatabase(ledgerPath, join(stage, "ledger.db"), character);
      imported.ledger = true;
    }
    await ctx.refreshDiscovery();
  } catch (error) {
    if (imported.history || imported.ledger) {
      try {
        removeStoredCharacter(historyPath, character);
        removeCharacterDatabaseRows(historyPath, ledgerPath, character, imported);
      } catch {}
    }
    for (const path of [...created].reverse()) await rm(path, { recursive: true, force: true });
    throw error;
  }
}

function copyOptions() {
  return {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true,
  } as const;
}

function requiredCharacter(value: unknown): string {
  if (typeof value !== "string" || !isUsableCharacterName(value)) {
    throw invalidRequest("Missing or invalid character name");
  }
  return value;
}

function requiredAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || !isAbsolute(value)) {
    throw invalidRequest(`${label} must be an absolute path`);
  }
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasEntries(path: string): Promise<boolean> {
  const glob = new Bun.Glob("**/*");
  for await (const _entry of glob.scan({ cwd: path, dot: true, onlyFiles: false })) return true;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
