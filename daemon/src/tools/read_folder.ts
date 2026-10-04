import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

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

export async function readFolder(path: string, maxChars: number, signal?: AbortSignal): Promise<string> {
  const listing: Listing = { lines: [], folders: 0, files: 0, hidden: 0, cut: false, chars: 0 };
  const budget = maxChars === 0 ? 50_000 : Math.max(1, maxChars - 512);
  await walk(path, "", listing, budget, signal);
  const header = `${path.endsWith("/") ? path : `${path}/`}: folder`;
  const footer = listing.cut
    ? `[Listing cut off after ${String(listing.lines.length)} entries; read a subfolder to see the rest.]`
    : `${String(listing.folders)} folder${listing.folders === 1 ? "" : "s"}, ${String(listing.files)} file${listing.files === 1 ? "" : "s"}`
      + (listing.hidden > 0 ? `; ${String(listing.hidden)} hidden not shown, read them by path` : "");
  return [header, ...listing.lines, footer].join("\n");
}
