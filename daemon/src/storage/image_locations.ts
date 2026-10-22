import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { sha256Hex } from "../engine/picture_ids.ts";
import type { ImageRef } from "../engine/types.ts";
import { imageCacheDir } from "./image_cache.ts";
import { characterMediaDir } from "./media.ts";

type ImageRoot = "cache" | "data";

export type StoredImageRef = ImageRef & { root?: ImageRoot };

export interface ImageDirs {
  data: string;
  cache: string | undefined;
}

export type Location = "kept" | "repointed" | "missing";

const DERIVED_COPY_DIRS = new Set(["model", "display"]);

function rootDirs(dirs: ImageDirs): [ImageRoot, string][] {
  const roots: [ImageRoot, string][] = [["data", resolve(dirs.data)]];
  if (dirs.cache !== undefined) roots.push(["cache", resolve(dirs.cache)]);
  return roots.sort(([, a], [, b]) => b.length - a.length);
}

function inside(dir: string, path: string): string | undefined {
  const rest = relative(dir, path);
  return rest === "" || isAbsolute(rest) || rest.split(sep)[0] === ".." ? undefined : rest;
}

export function storedImage(image: ImageRef, dirs: ImageDirs): StoredImageRef {
  if (!isAbsolute(image.path)) return image;
  for (const [root, dir] of rootDirs(dirs)) {
    const rest = inside(dir, resolve(image.path));
    if (rest !== undefined) return { ...image, path: rest.split(sep).join("/"), root };
  }
  return image;
}

export function loadedImage(image: StoredImageRef, dirs: ImageDirs | undefined): ImageRef {
  const dir = image.root === "cache" ? dirs?.cache : image.root === "data" ? dirs?.data : undefined;
  if (dir === undefined) return image;
  const { root: _root, ...rest } = image;
  const path = resolve(dir, rest.path);
  return { ...rest, path: inside(resolve(dir), path) === undefined ? "" : path };
}

function isFile(path: string): boolean {
  return path !== "" && statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function filesUnder(dir: string): string[] {
  return entriesOf(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory() === true) return DERIVED_COPY_DIRS.has(name) ? [] : filesUnder(path);
    return stat?.isFile() === true ? [path] : [];
  });
}

export class ImageLocator {
  readonly #dirs: ImageDirs;
  #byName: Map<string, string[]> | undefined;
  readonly #hashes = new Map<string, string | undefined>();

  constructor(dirs: ImageDirs) {
    this.#dirs = dirs;
  }

  locate(image: ImageRef): { image: ImageRef; location: Location } {
    if (isFile(image.path)) return { image: this.#withHash(image, image.path), location: "kept" };
    const found = this.#find(image);
    if (found === undefined) return { image, location: "missing" };
    return { image: this.#withHash({ ...image, path: found }, found), location: "repointed" };
  }

  #withHash(image: ImageRef, path: string): ImageRef {
    if (image.sha256 !== undefined || image.embed !== undefined) return image;
    const sha256 = this.#hash(path);
    return sha256 === undefined ? image : { ...image, sha256 };
  }

  #find(image: ImageRef): string | undefined {
    const index = this.#index();
    const named = index.get(basename(image.path)) ?? [];
    const wanted = image.sha256;
    if (wanted !== undefined) {
      return named.find((path) => this.#hash(path) === wanted) ??
        [...index.values()].flat().find((path) => this.#hash(path) === wanted);
    }
    const hashes = new Set(named.map((path) => this.#hash(path)));
    return hashes.size === 1 && !hashes.has(undefined) ? named[0] : undefined;
  }

  #index(): Map<string, string[]> {
    if (this.#byName !== undefined) return this.#byName;
    const { data, cache } = this.#dirs;
    const dirs = [
      ...(cache === undefined ? [] : entriesOf(join(cache, "characters")).map((character) => imageCacheDir(cache, character))),
      ...entriesOf(join(data, "media")).map((character) => characterMediaDir(data, character)),
    ];
    const byName = new Map<string, string[]>();
    for (const path of dirs.flatMap(filesUnder)) byName.set(basename(path), [...(byName.get(basename(path)) ?? []), path]);
    this.#byName = byName;
    return byName;
  }

  #hash(path: string): string | undefined {
    if (this.#hashes.has(path)) return this.#hashes.get(path);
    let sha256: string | undefined;
    try {
      sha256 = sha256Hex(readFileSync(path));
    } catch {
      sha256 = undefined;
    }
    this.#hashes.set(path, sha256);
    return sha256;
  }
}
