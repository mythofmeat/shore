import { expect, test } from "bun:test";
import type { WebArchiveInfo } from "../src/protocol/WebArchiveInfo.ts";
import type { WebRequestInfo } from "../src/protocol/WebRequestInfo.ts";
import type { CompactionReport } from "../src/protocol/CompactionReport.ts";
import { archiveStatus, parsePairs, requestStatus, sourceLabel } from "../src/browser/settings/format.ts";
import { adjacent, globalAction, paletteMatches, type KeyInput } from "../src/browser/app/shortcuts.ts";
import { compactionPhase, compactionSummary } from "../src/browser/chat/transcript.ts";
import { fieldLabel } from "../src/browser/ui/labels.ts";

test("key=value lines keep everything after the first equals sign and reject malformed lines", () => {
  expect(parsePairs("path=notes/trip.md\n\ncommand=echo a=b\nempty=")).toEqual({ path: "notes/trip.md", command: "echo a=b", empty: "" });
  expect(() => parsePairs("no separator")).toThrow("Use key=value");
  expect(() => parsePairs("=value")).toThrow("Use key=value");
});

test("request and archive phases each get their own plain-language status", () => {
  const request = (phase: WebRequestInfo["phase"], error?: string): WebRequestInfo => ({ id: "1", rid: "r", operation: "message", label: "Send message", character: "nova", thread: "main", started_at: 0, expires_at: 0, phase, result_omitted: false, ...(error === undefined ? {} : { error: { message: error } as WebRequestInfo["error"] & object }) });
  const phases: WebRequestInfo["phase"][] = ["running", "uncertain", "completed", "failed", "cancelled", "superseded"];
  expect(new Set(phases.map((phase) => requestStatus(request(phase)).text)).size).toBe(phases.length);
  expect(requestStatus(request("uncertain")).tone).toBe("bad");
  expect(requestStatus(request("failed", "provider down")).text).toBe("provider down");
  const archive = (phase: WebArchiveInfo["phase"], downloadable = false): WebArchiveInfo => ({ id: "a", filename: "nova.tar.gz", bytes: 1, expires_at: 0, phase, downloadable });
  const archivePhases: WebArchiveInfo["phase"][] = ["uploading", "ready", "exporting", "importing", "imported", "failed", "uncertain"];
  expect(new Set(archivePhases.map((phase) => archiveStatus(archive(phase)).text)).size).toBe(archivePhases.length);
  expect(archiveStatus(archive("ready", true)).text).toBe("Ready to download");
  expect(archiveStatus(archive("uncertain")).tone).toBe("bad");
});

test("model sources read as sentences, not internal identifiers", () => {
  expect(sourceLabel("character", "nova")).toBe("Chosen for nova");
  expect(sourceLabel("inherits chat", "nova")).toBe("Same as chat");
  expect(sourceLabel("chat.model", "nova")).toBe("From the configuration (chat.model)");
  expect(sourceLabel("thread side", "nova")).toBe("Chosen for conversation side");
  expect(sourceLabel("thread-default", "nova")).toBe("Uses nova’s default");
  expect(sourceLabel(null, "nova")).toBeUndefined();
  expect(fieldLabel("keep_turns")).toBe("Keep turns");
  expect(fieldLabel("maxOutputTokens")).toBe("Max Output Tokens");
});

test("global shortcuts respect the platform modifier and never fire help while typing", () => {
  const key = (event: Partial<KeyInput>): KeyInput => ({ key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...event });
  expect(globalAction(key({ key: "k", ctrlKey: true }), true)).toBe("palette");
  expect(globalAction(key({ key: "/", ctrlKey: true }), true)).toBe("focus");
  expect(globalAction(key({ key: "O", ctrlKey: true, shiftKey: true }), false)).toBe("new-thread");
  expect(globalAction(key({ key: "ArrowDown", altKey: true }), true)).toBe("next-thread");
  expect(globalAction(key({ key: "?" }), false)).toBe("help");
  expect(globalAction(key({ key: "?" }), true)).toBeUndefined();
  expect(globalAction(key({ key: "k" }), false)).toBeUndefined();
  expect(adjacent(["a", "b", "c"], "c", 1)).toBe("a");
  expect(adjacent(["a", "b", "c"], "a", -1)).toBe("c");
  expect(adjacent([], "a", 1)).toBeUndefined();
});

test("palette search needs every word to match somewhere in the label or detail", () => {
  const commands = [{ label: "Go to nova" }, { label: "Appearance", detail: "Settings · Chat" }, { label: "Compact context" }];
  expect(paletteMatches(commands, "")).toEqual([0, 1, 2]);
  expect(paletteMatches(commands, "settings chat")).toEqual([1]);
  expect(paletteMatches(commands, "NOVA")).toEqual([0]);
  expect(paletteMatches(commands, "nova appearance")).toEqual([]);
});

test("compaction notices follow the latest phase until its request finishes, and summaries cover every outcome", () => {
  const phase = (id: number, text: string) => ({ id, type: "phase", data: { phase: text } });
  expect(compactionPhase([phase(1, "compacting")])).toBe("Compacting context…");
  expect(compactionPhase([phase(1, "compacting round 3")])).toBe("Compacting context (round 3)…");
  expect(compactionPhase([phase(1, "compacting"), { id: 2, type: "request_finished", data: {} }])).toBeNull();
  expect(compactionPhase([{ id: 1, type: "request_finished", data: {} }, phase(2, "compacting")])).toBe("Compacting context…");
  expect(compactionPhase([phase(1, "thinking")])).toBeNull();
  const base = { character: "nova", message_count: 10, turn_count: 5, compacted_turns: 3, tool_rounds: 0, tools_called: [] };
  const reports: CompactionReport[] = [
    { ...base, status: "compacted", retained_count: 4, retained_turns: 2, memory_files_written: [], new_conversation_id: "x" },
    { ...base, status: "rotated", retained_count: 4, retained_turns: 2, dry_run: false, memory_files_written: [], archived_messages: 6 },
    { ...base, status: "dry_run", retained_count: 4, retained_turns: 2, would_write_files: 1, file_ops_preview: [] },
    { ...base, status: "truncated", truncated_turns: 1, partial_writes: [] },
    { ...base, status: "paused", checkpoint_id: "c", reason: "budget", detail: null, resume_at: null },
  ];
  expect(new Set(reports.map(compactionSummary)).size).toBe(reports.length);
  expect(compactionSummary(reports[4] as CompactionReport)).toContain("budget");
});
