import { rustLines, rustTrim, tokenizeQuery } from "./lines";
import type { MarkdownEntry, MarkdownMemoryStore } from "./markdown_store";

const MAX_DIRECT_HITS = 10;

const DIRECT_EXCERPT_LIMIT = 220;

export interface MemoryStatus {
  totalFiles: number;
  topicFiles: number;
  dailyFiles: number;
  imageFiles: number;
}

export async function memoryStatus(store: MarkdownMemoryStore): Promise<MemoryStatus> {
  const status: MemoryStatus = {
    totalFiles: 0,
    topicFiles: 0,
    dailyFiles: 0,
    imageFiles: 0,
  };
  for (const entry of await store.listAll()) {
    status.totalFiles += 1;
    if (entry.path.startsWith("daily/")) status.dailyFiles += 1;
    else if (entry.path.startsWith("images/")) status.imageFiles += 1;
    else status.topicFiles += 1;
  }
  return status;
}

export function formatDirectResponse(query: string, hits: MarkdownEntry[]): string {
  if (hits.length === 0) return `No memory files matched '${query}'.`;

  const lines = [`Top memory matches for '${query}':`];
  for (const entry of hits.slice(0, MAX_DIRECT_HITS)) {
    lines.push(`- ${entry.path}\n  ${excerptForQuery(entry.content, query, DIRECT_EXCERPT_LIMIT)}`);
  }
  return lines.join("\n");
}

export function truncateChars(text: string, limit: number): string {
  return [...text].slice(0, limit).join("");
}

export function excerptForQuery(text: string, query: string, limit: number): string {
  const normalizedQuery = rustTrim(query).toLowerCase();
  if (normalizedQuery === "") return excerpt(text, limit);

  const terms = tokenizeQuery(normalizedQuery);
  const lines = rustLines(text);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = rustTrim(lines[idx]!);
    if (line === "") continue;

    const lower = line.toLowerCase();
    if (!lower.includes(normalizedQuery) && !terms.some((term) => lower.includes(term))) {
      continue;
    }

    const start = Math.max(0, idx - 1);
    const end = Math.min(idx + 2, lines.length);
    const window = lines
      .slice(start, end)
      .map(rustTrim)
      .filter((l) => l !== "")
      .join(" ");

    return excerpt(window, limit);
  }

  return excerpt(text, limit);
}

function excerpt(text: string, limit: number): string {
  const normalized = rustLines(text)
    .map(rustTrim)
    .join(" ");
  if ([...normalized].length > limit) {
    return `${truncateChars(normalized, limit)}...`;
  }
  return normalized;
}
