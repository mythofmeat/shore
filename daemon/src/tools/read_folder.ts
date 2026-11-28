import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { Texts } from "../texts/texts.ts";

const MAX_ENTRIES = 2000;

interface Listing {
  lines: string[];
  folders: number;
  files: number;
  hidden: number;
  cut: boolean;
  chars: number;
}

async function walk(path: string, indent: string, listing: Listing, budget: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const all = await readdir(path, { withFileTypes: true });
  const entries = all.filter((entry) => !entry.name.startsWith(".")).sort((a, b) => a.name < b.name ? -1 : 1);
  listing.hidden += all.length - entries.length;
  for (const [index, entry] of entries.entries()) {
    const last = index === entries.length - 1;
    const target = entry.isSymbolicLink() ? ` -> ${await readlink(join(path, entry.name)).catch(() => "?")}` : "";
    const line = `${indent}${last ? "└── " : "├── "}${entry.name}${entry.isDirectory() ? "/" : ""}${target}`;
    if (listing.lines.length >= MAX_ENTRIES || listing.chars + line.length + 1 > budget) {
      listing.cut = true;
      return;
    }
    listing.lines.push(line);
    listing.chars += line.length + 1;
    if (entry.isDirectory()) {
      listing.folders += 1;
      await walk(join(path, entry.name), `${indent}${last ? "    " : "│   "}`, listing, budget, signal);
      if (listing.cut) return;
    } else {
      listing.files += 1;
    }
  }
}

function counted(count: number, one: string): string {
  return `${String(count)} ${one}${count === 1 ? "" : "s"}`;
}

export async function readFolder(texts: Texts, path: string, budget: number, signal?: AbortSignal): Promise<{ text: string; cut: boolean }> {
  const listing: Listing = { lines: [], folders: 0, files: 0, hidden: 0, cut: false, chars: 0 };
  await walk(path, "", listing, budget, signal);
  const header = texts.render("read_folder", { path: path.endsWith("/") ? path : `${path}/` });
  const footer = listing.cut
    ? texts.render("read_folder_cut", { entries: String(listing.lines.length) })
    : texts.render("read_folder_counts", { folders: counted(listing.folders, "folder"), files: counted(listing.files, "file"), hidden: listing.hidden > 0 ? String(listing.hidden) : undefined });
  return { text: [header, ...listing.lines, footer].filter((line) => line !== undefined).join("\n"), cut: listing.cut };
}
