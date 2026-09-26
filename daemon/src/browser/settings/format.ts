import type { WebArchiveInfo } from "../../protocol/WebArchiveInfo.ts";
import type { WebRequestInfo } from "../../protocol/WebRequestInfo.ts";

export function parsePairs(text: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const index = line.indexOf("=");
    if (index <= 0) throw new Error(`Use key=value on each line: “${line.trim()}”`);
    pairs[line.slice(0, index).trim()] = line.slice(index + 1);
  }
  return pairs;
}

export function requestStatus(request: WebRequestInfo): { text: string; tone: "ok" | "wait" | "bad" } {
  switch (request.phase) {
    case "running": return { text: "Still running", tone: "wait" };
    case "uncertain": return { text: "Outcome unknown: the connection dropped before it finished. Check the affected conversation or setting before trying again.", tone: "bad" };
    case "completed": return { text: "Completed", tone: "ok" };
    case "failed": return { text: request.error?.message ?? "Failed", tone: "bad" };
    case "cancelled": return { text: "Cancelled", tone: "wait" };
    case "superseded": return { text: "Replaced by newer work", tone: "wait" };
  }
}

export function archiveStatus(archive: WebArchiveInfo): { text: string; tone: "ok" | "wait" | "bad" } {
  switch (archive.phase) {
    case "uploading": return { text: "Uploading…", tone: "wait" };
    case "exporting": return { text: "Preparing the export…", tone: "wait" };
    case "importing": return { text: "Importing…", tone: "wait" };
    case "ready": return { text: archive.downloadable ? "Ready to download" : "Uploaded, ready to import", tone: "ok" };
    case "imported": return { text: archive.result?.name === "import_character" ? `Imported ${archive.result.data.character}` : "Imported", tone: "ok" };
    case "failed": return { text: archive.error ?? "Failed", tone: "bad" };
    case "uncertain": return { text: "The import may or may not have finished. Check the character list before trying again.", tone: "bad" };
  }
}

export function sourceLabel(source: string | null | undefined, character: string | null): string | undefined {
  if (source === null || source === undefined || source === "") return undefined;
  if (source === "character") return `Chosen for ${character ?? "this character"}`;
  if (source.startsWith("inherits chat")) return `Same as chat${source.slice("inherits chat".length)}`;
  if (source.startsWith("thread ")) return `Chosen for conversation ${source.slice(7)}`;
  if (source === "first in catalog") return "First model in the catalog";
  if (source === "subagent") return "Chosen for this subagent";
  if (source === "thread-default") return `Uses ${character ?? "the character"}’s default`;
  if (/^[\w.]+\.model$/.test(source)) return `From the configuration (${source})`;
  return source;
}
