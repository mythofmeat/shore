import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const characterMediaDir = (data: string, character: string): string => join(data, "media", character);

export function migrateCharacterMedia(data: string, character: string): void {
  const legacy = join(data, character, "images");
  const destination = characterMediaDir(data, character);
  if (!existsSync(legacy)) {
    if (existsSync(destination)) {
      mkdirSync(dirname(legacy), { recursive: true });
      symlinkSync(relative(dirname(legacy), destination), legacy, "dir");
    }
    return;
  }
  if (lstatSync(legacy).isSymbolicLink()) return;
  mkdirSync(dirname(destination), { recursive: true });
  if (!existsSync(destination)) {
    renameSync(legacy, destination);
    symlinkSync(relative(dirname(legacy), destination), legacy, "dir");
    return;
  }
  moveContents(legacy, destination);
}

function moveContents(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const old = join(source, entry.name);
    if (entry.isSymbolicLink()) continue;
    let target = join(destination, entry.name);
    if (entry.isDirectory()) {
      moveContents(old, target);
      continue;
    }
    if (!entry.isFile()) continue;
    if (existsSync(target)) {
      const bytes = readFileSync(old);
      if (readFileSync(target).equals(bytes)) rmSync(old);
      else {
        const hash = createHash("sha256").update(bytes).digest("hex");
        target = join(destination, `${hash}-${entry.name}`);
        if (existsSync(target)) {
          if (!readFileSync(target).equals(bytes)) throw new Error(`Media conflict at ${target}`);
          rmSync(old);
        } else renameSync(old, target);
      }
    } else renameSync(old, target);
    symlinkSync(relative(dirname(old), target), old, "file");
  }
}
