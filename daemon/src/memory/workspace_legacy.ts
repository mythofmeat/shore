import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { characterCacheDir } from "../config/dirs.ts";
import { toF32 } from "../llm/embed.ts";
import { documentHash, type FileRow, type WorkspaceIndexStore } from "./workspace_store.ts";

export const LEGACY_INDEX_FILE = "workspace_index.json";

export interface LegacyEntry {
  hash: string;
  size: number;
  modified_at_secs: number;
  model_id: string;
  max_embed_chars_per_file?: number;
  embedded: boolean;
  reason?: string;
  embedding: number[];
}

export interface LegacyIndex {
  entries: Map<string, LegacyEntry>;
}

export function legacyIndexPath(cacheDir: string, character: string): string {
  return join(characterCacheDir(cacheDir, character), LEGACY_INDEX_FILE);
}

export interface LegacyMigrationOutcome {
  files: number;
  vectors: number;
  stale: number;
}

export async function migrateLegacyIndex(
  store: WorkspaceIndexStore,
  legacyPath: string,
  workspaceDir: string,
  buildDocument: (displayPath: string, text: string, cap: number) => string,
): Promise<LegacyMigrationOutcome | undefined> {
  const legacy = await loadLegacyIndex(legacyPath);
  if (legacy === undefined) return undefined;

  const rows: FileRow[] = [];
  const vectors: { hash: string; vector: number[] }[] = [];
  const byModel = new Map<string, { hash: string; vector: number[] }[]>();
  let stale = 0;

  for (const [displayPath, entry] of legacy.entries) {
    if (!entry.embedded) {
      rows.push({
        display_path: displayPath,
        size: entry.size,
        modified_at_secs: entry.modified_at_secs,
        document_hash: "",
        embed_chars: entry.max_embed_chars_per_file ?? 0,
        embedded: false,
        reason: entry.reason,
      });
      continue;
    }

    const carried = await carryVector(entry, displayPath, workspaceDir, buildDocument);
    if (carried === undefined) {
      stale += 1;
      continue;
    }

    rows.push({
      display_path: displayPath,
      size: entry.size,
      modified_at_secs: entry.modified_at_secs,
      document_hash: carried.hash,
      embed_chars: entry.max_embed_chars_per_file ?? 0,
      embedded: true,
      reason: undefined,
    });
    const bucket = byModel.get(entry.model_id);
    if (bucket === undefined) byModel.set(entry.model_id, [carried]);
    else bucket.push(carried);
    vectors.push(carried);
  }

  store.putFiles(rows);
  for (const [model, entries] of byModel) {
    store.putEmbeddings(
      model,
      entries.map((entry) => ({ hash: entry.hash, vectors: [entry.vector] })),
    );
  }
  store.setMetadata("migrated_from_json_at", new Date().toISOString());

  try {
    await unlink(legacyPath);
  } catch {}

  return { files: rows.length, vectors: vectors.length, stale };
}

async function carryVector(
  entry: LegacyEntry,
  displayPath: string,
  workspaceDir: string,
  buildDocument: (displayPath: string, text: string, cap: number) => string,
): Promise<{ hash: string; vector: number[] } | undefined> {
  if (entry.embedding.length === 0) return undefined;
  const fsPath = join(workspaceDir, displayPath);

  let meta;
  try {
    meta = await stat(fsPath);
  } catch {
    return undefined;
  }
  if (meta.size !== entry.size) return undefined;
  if (Math.floor(meta.mtimeMs / 1000) !== entry.modified_at_secs) return undefined;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(fsPath),
    );
  } catch {
    return undefined;
  }

  const document = buildDocument(displayPath, text, entry.max_embed_chars_per_file ?? 0);
  return { hash: documentHash(document), vector: entry.embedding };
}

export async function loadLegacyIndex(path: string): Promise<LegacyIndex | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: new Map() };
  }
  return parseLegacyIndex(parsed) ?? { entries: new Map() };
}

function parseLegacyIndex(value: unknown): LegacyIndex | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entriesValue = (value as { entries?: unknown }).entries;
  if (typeof entriesValue !== "object" || entriesValue === null || Array.isArray(entriesValue)) {
    return undefined;
  }
  const entries = new Map<string, LegacyEntry>();
  for (const [path, raw] of Object.entries(entriesValue as Record<string, unknown>)) {
    const entry = parseLegacyEntry(raw);
    if (entry === undefined) return undefined;
    entries.set(path, entry);
  }
  return { entries };
}

function parseLegacyEntry(value: unknown): LegacyEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  if (typeof v.hash !== "string") return undefined;
  if (typeof v.model_id !== "string") return undefined;
  if (typeof v.embedded !== "boolean") return undefined;
  if (!Number.isInteger(v.size) || (v.size as number) < 0) return undefined;
  if (!Number.isInteger(v.modified_at_secs)) return undefined;

  let cap: number | undefined;
  if (v.max_embed_chars_per_file !== undefined && v.max_embed_chars_per_file !== null) {
    if (!Number.isInteger(v.max_embed_chars_per_file) || (v.max_embed_chars_per_file as number) < 0)
      return undefined;
    cap = v.max_embed_chars_per_file as number;
  }

  let reason: string | undefined;
  if (v.reason !== undefined && v.reason !== null) {
    if (typeof v.reason !== "string") return undefined;
    reason = v.reason;
  }

  let embedding: number[] = [];
  if (v.embedding !== undefined) {
    if (!Array.isArray(v.embedding)) return undefined;
    if (v.embedding.some((n) => typeof n !== "number")) return undefined;
    embedding = (v.embedding as number[]).map(toF32);
  }

  return {
    hash: v.hash,
    size: v.size as number,
    modified_at_secs: v.modified_at_secs as number,
    model_id: v.model_id,
    ...(cap !== undefined ? { max_embed_chars_per_file: cap } : {}),
    embedded: v.embedded,
    ...(reason !== undefined ? { reason } : {}),
    embedding,
  };
}
