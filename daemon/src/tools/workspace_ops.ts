import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ImagesConfig } from "../config/app.ts";
import { handleEdit } from "./edit.ts";
import { InvalidArgs, NotImplemented, ToolIoError } from "./errors.ts";
import { carryToolMedia, toolMediaOf, type ToolResultPayload } from "./media.ts";
import { handleRead } from "./read.ts";
import { lookUpPictures, type PictureLookup, type PictureTarget } from "./message_pictures.ts";
import { restoreWorkspaceEntry, snapshotWorkspace, workspaceEntry, type WorkspaceEntry } from "./workspace_snapshot.ts";

export type FileRead = { data: string } | { error: { code?: string; message: string } };

export type EncodedToolValue = { value: unknown } | { media: ToolResultPayload };

export interface WorkspaceOpTable {
  read: (args: { input: Record<string, unknown>; workspaceDir: string; maxChars?: number; maxImageBytes?: number; images?: ImagesConfig }, signal?: AbortSignal) => Promise<EncodedToolValue>;
  edit: (args: { input: Record<string, unknown>; workspaceDir: string }, signal?: AbortSignal) => Promise<string>;
  pictures: (args: { workspaceDir: string; targets: PictureTarget[] }, signal?: AbortSignal) => Promise<PictureLookup[]>;
  readFiles: (args: { paths: string[] }) => Promise<FileRead[]>;
  exists: (args: { paths: string[] }) => Promise<boolean[]>;
  mkdir: (args: { path: string }) => Promise<void>;
  createFile: (args: { path: string; data: string }) => Promise<boolean>;
  writeFile: (args: { path: string; data: string }) => Promise<void>;
  deleteFile: (args: { path: string }) => Promise<void>;
  realpath: (args: { path: string }) => Promise<string>;
  entries: (args: { path: string }) => Promise<string[] | null>;
  clear: (args: { path: string }) => Promise<void>;
  remove: (args: { root: string; path: string }) => Promise<void>;
  snapshot: (args: { root: string }) => Promise<[string, WorkspaceEntry][]>;
  entry: (args: { path: string }) => Promise<WorkspaceEntry | null>;
  restore: (args: { path: string; entry: WorkspaceEntry | null }) => Promise<void>;
}

export type WorkspaceOp = keyof WorkspaceOpTable;

export type OpArgs<K extends WorkspaceOp> = Parameters<WorkspaceOpTable[K]>[0];

export type OpResult<K extends WorkspaceOp> = Awaited<ReturnType<WorkspaceOpTable[K]>>;

export function encodeToolValue(value: unknown): EncodedToolValue {
  const media = toolMediaOf(value);
  return media === undefined ? { value } : { media };
}

export function decodeToolValue(encoded: EncodedToolValue): unknown {
  return "media" in encoded ? carryToolMedia(encoded.media) : encoded.value;
}

async function pruneEmptyParents(root: string, path: string): Promise<void> {
  for (let parent = dirname(path); parent !== "." && parent !== "/" && parent !== ""; parent = dirname(parent)) {
    try {
      await rmdir(join(root, parent));
    } catch {
      return;
    }
  }
}

export const WORKSPACE_OPS: WorkspaceOpTable = {
  read: async ({ input, workspaceDir, maxChars, maxImageBytes, images }, signal) =>
    encodeToolValue(await handleRead(input, workspaceDir, signal, maxChars, maxImageBytes, images)),
  edit: async ({ input, workspaceDir }, signal) => await handleEdit(input, workspaceDir, signal),
  pictures: async (args, signal) => await lookUpPictures(args, signal),
  readFiles: async ({ paths }) => await Promise.all(paths.map(async (path): Promise<FileRead> => {
    try {
      return { data: (await readFile(path)).toString("base64") };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { error: { ...(code === undefined ? {} : { code }), message: error instanceof Error ? error.message : String(error) } };
    }
  })),
  exists: async ({ paths }) => await Promise.all(paths.map(async (path) => {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  })),
  mkdir: async ({ path }) => {
    await mkdir(path, { recursive: true });
  },
  createFile: async ({ path, data }) => {
    try {
      await writeFile(path, Buffer.from(data, "base64"), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  },
  writeFile: async ({ path, data }) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(data, "base64"));
  },
  deleteFile: async ({ path }) => {
    await rm(path);
  },
  realpath: async ({ path }) => await realpath(path),
  entries: async ({ path }) => {
    try {
      return (await readdir(path)).sort();
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
  },
  clear: async ({ path }) => {
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) await rm(join(path, name), { recursive: true, force: true });
  },
  remove: async ({ root, path }) => {
    await rm(join(root, path), { recursive: true, force: true });
    await pruneEmptyParents(root, path);
  },
  snapshot: async ({ root }) => [...await snapshotWorkspace(root)],
  entry: async ({ path }) => await workspaceEntry(path),
  restore: async ({ path, entry }) => {
    await restoreWorkspaceEntry(path, entry);
  },
};

export function isWorkspaceOp(name: string): name is WorkspaceOp {
  return Object.hasOwn(WORKSPACE_OPS, name);
}

export interface EncodedError {
  name: string;
  message: string;
  code?: string;
}

export function encodeError(error: unknown): EncodedError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const code = (error as NodeJS.ErrnoException).code;
  return { name: error.name, message: error.message, ...(typeof code === "string" ? { code } : {}) };
}

const ERROR_TYPES: Record<string, { prototype: Error }> = {
  InvalidArgs,
  ToolIoError,
  NotImplemented,
};

export function decodeError(encoded: EncodedError): Error {
  const error = new Error(encoded.message);
  const type = ERROR_TYPES[encoded.name];
  if (type !== undefined) Object.setPrototypeOf(error, type.prototype);
  error.name = encoded.name;
  if (encoded.code !== undefined) (error as NodeJS.ErrnoException).code = encoded.code;
  return error;
}
