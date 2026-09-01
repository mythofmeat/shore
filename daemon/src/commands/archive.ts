import { chmod, cp, link, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { create, extract } from "tar";

import type { ShoreDirs } from "../config/dirs.ts";
import {
  SOUL_FILE,
  characterConfigDir,
  characterDataDir,
  characterWorkspaceDir,
  isUsableCharacterName,
  rustJoin,
} from "../config/dirs.ts";
import { invalidRequest, notFound } from "./errors.ts";
import type { Args } from "./navigation.ts";
import {
  exportHistoryDatabase,
  exportLedgerDatabase,
  importHistoryDatabase,
  importLedgerDatabase,
  removeImportedDatabaseRows,
} from "./archive_databases.ts";

const FORMAT = "shore-character";
const VERSION = 1;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const TOP_LEVEL = new Set(["manifest.json", "config", "workspace", "data", "history.db", "ledger.db"]);

export interface ArchiveContext {
  readonly dirs: ShoreDirs;
  hasCharacter(name: string): boolean;
  withSnapshot<T>(run: () => Promise<T>): Promise<T>;
  refreshAfterImport(): Promise<void>;
}

interface Manifest {
  format: typeof FORMAT;
  version: typeof VERSION;
  character: string;
  created_at: string;
  contents: {
    config: boolean;
    workspace: true;
    data: boolean;
    history: true;
    ledger: true;
    call_diagnostics: false;
    external_memory_bank: false;
  };
}

export async function exportCharacter(ctx: ArchiveContext, args: Args): Promise<unknown> {
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
      ["manifest.json", "config", "workspace", "data", "history.db", "ledger.db"],
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
      call_diagnostics: "excluded_disposable_cache",
      external_memory: "rebuild_from_archived_segments",
    };
  } finally {
    await unlink(temporaryOutput).catch(() => {});
    await rm(stage, { recursive: true, force: true });
  }
}

export async function importCharacter(ctx: ArchiveContext, args: Args): Promise<unknown> {
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

  exportHistoryDatabase(
    rustJoin(dirs.data, "history.db"),
    character,
    join(stage, "history.db"),
  );
  exportLedgerDatabase(
    rustJoin(dirs.data, "ledger.db"),
    character,
    join(stage, "ledger.db"),
  );
  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    character,
    created_at: new Date().toISOString(),
    contents: {
      config: await hasEntries(join(stage, "config")),
      workspace: true,
      data: await hasEntries(join(stage, "data")),
      history: true,
      ledger: true,
      call_diagnostics: false,
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
  if (!isRecord(value) || value["format"] !== FORMAT || value["version"] !== VERSION) {
    throw invalidRequest("Unsupported or malformed Shore character archive");
  }
  const character = value["character"];
  if (typeof character !== "string" || !isUsableCharacterName(character)) {
    throw invalidRequest("Archive has an invalid character name");
  }
  if (!await exists(join(stage, "workspace", SOUL_FILE))) {
    throw invalidRequest(`Archive has no workspace/${SOUL_FILE}`);
  }
  for (const file of ["history.db", "ledger.db"]) {
    if (!await exists(join(stage, file))) throw invalidRequest(`Archive has no ${file}`);
  }
  return value as unknown as Manifest;
}

async function installCharacter(ctx: ArchiveContext, stage: string, character: string): Promise<void> {
  const configTarget = characterConfigDir(ctx.dirs.config, character);
  const workspaceTarget = characterWorkspaceDir(ctx.dirs.config, character, ctx.dirs.workspace);
  const dataTarget = characterDataDir(ctx.dirs.data, character);
  const occupied = [configTarget, workspaceTarget, dataTarget].filter((path, index, all) =>
    all.indexOf(path) === index,
  );
  if (ctx.hasCharacter(character) || (await Promise.all(occupied.map(exists))).some(Boolean)) {
    throw invalidRequest(`Refusing to overwrite existing character '${character}'`);
  }

  const historyPath = rustJoin(ctx.dirs.data, "history.db");
  const ledgerPath = rustJoin(ctx.dirs.data, "ledger.db");
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

    importHistoryDatabase(historyPath, join(stage, "history.db"), character);
    imported.history = true;
    importLedgerDatabase(ledgerPath, join(stage, "ledger.db"), character);
    imported.ledger = true;
    await ctx.refreshAfterImport();
  } catch (error) {
    if (imported.history || imported.ledger) {
      try {
        removeImportedDatabaseRows(historyPath, ledgerPath, character, imported);
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
