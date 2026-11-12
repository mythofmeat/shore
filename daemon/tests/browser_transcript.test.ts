import { describe, expect, test } from "bun:test";

import type { CompactionPassEnd } from "../src/protocol/CompactionPassEnd.ts";
import type { CompactionReport } from "../src/protocol/CompactionReport.ts";
import type { ContentBlock } from "../src/protocol/ContentBlock.ts";
import type { Message } from "../src/protocol/Message.ts";
import type { SegmentSummary } from "../src/protocol/SegmentSummary.ts";
import {
  activityHeadline,
  blockViews,
  bodyItems,
  chatLogMessageId,
  compactionPhase,
  compactionSummary,
  compactionWatchSummary,
  dayLabel,
  formatToolInput,
  isChatLogTool,
  lastTurnIndex,
  messageCopyLabel,
  optimisticRegenReplaces,
  regenReplaces,
  replyBlocks,
  savedPart,
  segmentDetail,
  segmentName,
  swipeState,
  timeLabel,
  toolSummary,
  transcriptItems,
  visibleStreams,
  type StepView,
} from "../src/browser/chat/transcript.ts";

function message(msgId: string, role: Message["role"], blocks: ContentBlock[] = [], timestamp = "2026-11-10T10:00:00"): Message {
  return { msg_id: msgId, role, content: "", images: [], content_blocks: blocks, timestamp };
}

const text = (value: string): ContentBlock => ({ type: "text", text: value });
const thinking = (value: string): ContentBlock => ({ type: "thinking", thinking: value });
const READ_INPUT = { path: "a.md" };
const toolUse = (id: string, name = "read", input: unknown = READ_INPUT): ContentBlock => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, content: Extract<ContentBlock, { type: "tool_result" }>["content"], isError?: boolean): ContentBlock =>
  ({ type: "tool_result", tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) });

function segment(overrides: Partial<SegmentSummary> = {}): SegmentSummary {
  return {
    index: 3, first_message_at: null, last_message_at: null, compacted_at: "2026-11-10T00:00:00Z",
    turn_count: 2, excluded: false, label: null, note: null, memory_before: null, memory_after: null, ...overrides,
  };
}

describe("dates and times", () => {
  const now = new Date(2026, 10, 10, 0, 10);

  test("a day reads as today or yesterday, then by weekday within a week, and with its year only when it differs", () => {
    expect(dayLabel(new Date(2026, 10, 10, 23, 59), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 9, 23, 30), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 10, 1, 9), new Date(2026, 10, 2, 0, 5))).toBe("Yesterday");
    const threeDays = new Date(2026, 10, 7, 12);
    expect(dayLabel(threeDays, now)).toBe(threeDays.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
    const sixDays = new Date(2026, 10, 4, 12);
    expect(dayLabel(sixDays, now)).toContain(sixDays.toLocaleDateString(undefined, { weekday: "long" }));
    const week = new Date(2026, 10, 3, 12);
    expect(dayLabel(week, now)).toBe(week.toLocaleDateString(undefined, { month: "long", day: "numeric" }));
    const tomorrow = new Date(2026, 10, 11, 9);
    expect(dayLabel(tomorrow, now), "a day still to come reads by weekday").toBe(tomorrow.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
    expect(dayLabel(new Date(2026, 2, 8, 12), new Date(2026, 2, 9, 0, 30)), "across a clock change").toBe("Yesterday");
    expect(dayLabel(new Date(2025, 11, 31, 22), new Date(2026, 0, 1, 1)), "across the new year").toBe("Yesterday");
    const lastYear = new Date(2025, 11, 31, 12);
    expect(dayLabel(lastYear, now)).toBe(lastYear.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }));
  });

  test("a time reads in the hour and minute, and a broken timestamp reads as nothing", () => {
    const at = "2026-11-10T09:05:00";
    expect(timeLabel(at)).toBe(new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(timeLabel("not a time")).toBe("");
  });

  test("the transcript gets a day line wherever the day changes, and its last turn is marked", () => {
    const messages = [
      message("m_1", "user", [], "2026-11-09T22:00:00"),
      message("m_2", "assistant", [], "2026-11-09T23:00:00"),
      message("m_3", "user", [], "2026-11-10T08:00:00"),
      message("m_4", "assistant", [], "not a time"),
      message("m_5", "system", [], "2026-11-10T09:00:00"),
    ];
    const items = transcriptItems(messages, new Date(2026, 10, 10, 12));
    expect(items.map((item) => item.kind === "day" ? `day ${item.label}` : `${item.message.msg_id}${item.last ? " last" : ""}`)).toEqual([
      "day Yesterday", "m_1", "m_2", "day Today", "m_3", "m_4 last", "m_5",
    ]);
    expect(items.filter((item) => item.kind === "day").map((item) => item.key)).toEqual(["day:2026-10-9:m_1", "day:2026-10-10:m_3"]);
    expect(items.flatMap((item) => item.kind === "message" ? [item.index] : [])).toEqual([0, 1, 2, 3, 4]);
    expect(lastTurnIndex(messages)).toBe(3);
    expect(lastTurnIndex([message("m_9", "system")])).toBe(-1);
  });
});

describe("segments and chat logs", () => {
  test("a segment is named by its number and label, and described by its size, dates and exclusion", () => {
    expect(segmentName({ index: 3, label: null })).toBe("Segment 3");
    expect(segmentName({ index: 3, label: "the storm" })).toBe("Segment 3 · the storm");
    const now = new Date(2026, 10, 10);
    const day = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(segmentDetail(segment({ turn_count: 1 }), now)).toBe("1 turn");
    expect(segmentDetail(segment({ first_message_at: "2026-11-01T10:00:00", last_message_at: "2026-11-01T11:00:00" }), now))
      .toBe(`2 turns · ${day("2026-11-01T10:00:00")}`);
    expect(segmentDetail(segment({ first_message_at: "2026-11-01T10:00:00", last_message_at: "2026-11-03T11:00:00", excluded: true }), now))
      .toBe(`2 turns · ${day("2026-11-01T10:00:00")} – ${day("2026-11-03T11:00:00")} · excluded from memory`);
    expect(segmentDetail(segment({ last_message_at: "2026-11-03T11:00:00" }), now)).toBe(`2 turns · ${day("2026-11-03T11:00:00")}`);
    expect(segmentDetail(segment({ first_message_at: "2026-11-01T10:00:00", last_message_at: "garbled" }), now)).toBe(`2 turns · ${day("2026-11-01T10:00:00")}`);
    expect(segmentDetail(segment({ first_message_at: "2025-12-30T10:00:00" }), now))
      .toBe(`2 turns · ${new Date("2025-12-30T10:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`);
  });

  test("a chat log line names its message at the end, with or without a marker, and other lines name none", () => {
    expect(isChatLogTool("search_chat_logs") && isChatLogTool("read_chat_logs")).toBe(true);
    expect(isChatLogTool("read")).toBe(false);
    expect(chatLogMessageId("2026-11-10 Tue 09:05  ada: hello there  m_42")).toBe("m_42");
    expect(chatLogMessageId("▶ 2026-11-10 Tue 09:05  ada: the match  m_7 (thread story)")).toBe("m_7");
    expect(chatLogMessageId("2026-11-10 Tue 09:05  ")).toBeUndefined();
    expect(chatLogMessageId("2026-11-10 09:05  ada: no weekday  m_1")).toBeUndefined();
    expect(chatLogMessageId("   2026-11-10 Tue 09:05  indented  m_1")).toBeUndefined();
  });

  test("a message's copy says which thread and segment holds it", () => {
    expect(messageCopyLabel({ thread: "main", segment: null, excluded: false })).toBe("main, not archived");
    expect(messageCopyLabel({ thread: "story", segment: 4, excluded: false })).toBe("story segment 4");
    expect(messageCopyLabel({ thread: "story", segment: 4, excluded: true })).toBe("story segment 4, excluded");
  });
});

describe("what a reply shows", () => {
  test("blocks become views, pairing each tool call with its result and dropping blank text", () => {
    const views = blockViews([
      text("  "), text("hello"), thinking(" "), thinking("hmm"), { type: "redacted_thinking", data: "x" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
      toolUse("t_1"), toolResult("t_1", [text("line one"), { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }, text("line two")], true),
      toolUse("t_2", "bash", "ls"), toolResult("t_2", "plain output"),
      toolResult("t_9", "orphan"),
      toolUse("t_3", "grep"),
      toolResult("t_8", "failed orphan", true),
    ]);
    expect(views).toEqual([
      { kind: "text", key: "1", text: "hello" },
      { kind: "thinking", key: "3", text: "hmm", redacted: false },
      { kind: "thinking", key: "4", text: "", redacted: true },
      { kind: "image", key: "5", source: "data:image/png;base64,iVBOR" },
      { kind: "tool", key: "tool:t_1", id: "t_1", name: "read", input: { path: "a.md" }, output: "line one\nline two", error: true, images: ["data:image/jpeg;base64,/9j/"] },
      { kind: "tool", key: "tool:t_2", id: "t_2", name: "bash", input: "ls", output: "plain output", error: false, images: [] },
      { kind: "tool", key: "10", id: "t_9", name: "tool", input: null, output: "orphan", error: false, images: [] },
      { kind: "tool", key: "tool:t_3", id: "t_3", name: "grep", input: { path: "a.md" }, output: null, error: false, images: [] },
      { kind: "tool", key: "12", id: "t_8", name: "tool", input: null, output: "failed orphan", error: true, images: [] },
    ]);
  });

  test("runs of thinking and tool use fold into one activity between the text around them", () => {
    const items = bodyItems(blockViews([thinking("a"), toolUse("t_1"), text("middle"), toolUse("t_2"), text("end")]));
    expect(items.map((item) => item.kind === "activity" ? `activity ${item.key} ${String(item.steps.length)}` : item.kind)).toEqual([
      "activity activity:0 2", "text", "activity activity:tool:t_2 1", "text",
    ]);
  });

  test("an activity says what is happening while live and sums up the tools once done", () => {
    const step = (block: ContentBlock[]): StepView[] => blockViews(block).filter((view): view is StepView => view.kind === "thinking" || view.kind === "tool");
    expect(activityHeadline(step([thinking("a")]), true)).toEqual({ label: "Thinking…", detail: "" });
    expect(activityHeadline(step([thinking("a"), toolUse("t_1", "read", { path: "notes.md\nmore" })]), true)).toEqual({ label: "read", detail: "notes.md" });
    expect(activityHeadline(step([toolUse("t_1"), toolResult("t_1", "x")]), true)).toEqual({ label: "Used 1 tool", detail: "read" });
    expect(activityHeadline(step([thinking("a")]), false)).toEqual({ label: "Reasoning", detail: "" });
    expect(activityHeadline(step([thinking("a"), toolUse("t_1"), toolUse("t_2")]), false)).toEqual({ label: "Reasoned and used 2 tools", detail: "read" });
    const many = step(["read", "bash", "grep", "edit", "write", "read"].map((name, index) => toolUse(`t_${String(index)}`, name)));
    expect(activityHeadline(many, false)).toEqual({ label: "Used 6 tools", detail: "read, bash, grep and 2 more" });
    expect(activityHeadline(step(["a", "b", "c"].map((name) => toolUse(name, name))), false).detail).toBe("a, b, c");
    expect(activityHeadline(step(["a", "b", "c", "d"].map((name) => toolUse(name, name))), false).detail).toBe("a, b, c and 1 more");
  });

  test("a tool's input is summed up by its first text, or its first number, and laid out in full otherwise", () => {
    expect(toolSummary(null)).toBe("");
    expect(toolSummary(undefined)).toBe("");
    expect(toolSummary("ls -la")).toBe("ls -la");
    expect(toolSummary(42)).toBe("42");
    expect(toolSummary(true)).toBe("true");
    expect(toolSummary({ empty: "  ", count: 3, path: "a.md\nb.md" })).toBe("a.md");
    expect(toolSummary({ count: 3, flag: false })).toBe("3");
    expect(toolSummary({ nested: { path: "x" } })).toBe("");
    expect(toolSummary(Symbol("odd"))).toBe("");
    expect(formatToolInput(null)).toBe("");
    expect(formatToolInput("ls")).toBe("ls");
    expect(formatToolInput({ path: "a.md", limit: 5, recursive: false, filter: { kind: "md" } })).toBe('path: a.md\nlimit: 5\nrecursive: false\nfilter: {\n  "kind": "md"\n}');
  });

  test("swipes count from one and say whether there is one before or after", () => {
    expect(swipeState({})).toEqual({ position: 1, count: 1, canPrevious: false, atLast: true });
    expect(swipeState({ alt_count: 3 })).toEqual({ position: 3, count: 3, canPrevious: true, atLast: true });
    expect(swipeState({ alt_index: 0, alt_count: 3 })).toEqual({ position: 1, count: 3, canPrevious: false, atLast: false });
    expect(swipeState({ alt_index: 1, alt_count: 3 })).toEqual({ position: 2, count: 3, canPrevious: true, atLast: false });
    expect(swipeState({ alt_index: 9, alt_count: 3 })).toEqual({ position: 3, count: 3, canPrevious: true, atLast: true });
    expect(swipeState({ alt_index: -4, alt_count: 0 })).toEqual({ position: 1, count: 1, canPrevious: false, atLast: true });
  });
});

describe("a reply still arriving", () => {
  const stream = (overrides: Partial<Parameters<typeof replyBlocks>[0]> = {}): Parameters<typeof replyBlocks>[0] =>
    ({ reasoning: "", text: "", blocks: [], tools: [], round: { reasoning: "", text: "", tools: [] }, ...overrides });

  test("the saved part of a reply is the last message when it shares a tool call or waits on one", () => {
    expect(savedPart([], stream())).toBeUndefined();
    const sharing = message("m_2", "assistant", [toolUse("t_1")]);
    expect(savedPart([sharing], stream({ tools: ["t_1"] }))).toBe(sharing);
    expect(savedPart([sharing], stream()), "a saved tool call the stream has not reached yet").toBe(sharing);
    expect(savedPart([sharing], stream({ tools: ["t_8"] }))).toBeUndefined();
    expect(savedPart([message("m_2", "assistant", [text("done")])], stream())).toBeUndefined();
  });

  test("a live reply shows what was saved, then what has not been saved yet, then its unanswered tools", () => {
    expect(replyBlocks(stream({ reasoning: "r", text: "t" }), undefined)).toEqual([thinking("r"), text("t")]);
    expect(replyBlocks(stream({ blocks: [toolUse("t_1")], tools: ["t_1"] }), undefined)).toEqual([toolUse("t_1")]);
    const saved = message("m_2", "assistant", [thinking("before"), toolUse("t_1"), toolResult("t_1", "ok")]);
    expect(replyBlocks(stream({
      reasoning: "before after", text: "done", tools: ["t_1", "t_2"],
      blocks: [toolUse("t_1"), toolResult("t_1", "ok"), toolUse("t_2"), toolResult("t_2", "late")],
      round: { reasoning: "after", text: "done", tools: ["t_2"] },
    }), saved)).toEqual([thinking("before"), toolUse("t_1"), toolResult("t_1", "ok"), thinking("after"), text("done"), toolUse("t_2"), toolResult("t_2", "late")]);
    expect(replyBlocks(stream({
      text: "first round then more", tools: ["t_1"], blocks: [toolUse("t_1")],
      round: { reasoning: "", text: "then more", tools: [] },
    }), message("m_2", "assistant", [text("first round"), toolUse("t_1")]))).toEqual([text("first round"), toolUse("t_1"), text("then more")]);
    expect(replyBlocks(stream({ text: "unsaved", tools: [], round: { reasoning: "", text: "unsaved", tools: [] } }), message("m_2", "assistant", [toolUse("t_5")])), "the saved call was the stream's own last round")
      .toEqual([toolUse("t_5")]);
  });

  test("only the main reply's streams show, and a finished one only until its message is saved", () => {
    const live = { subagent: null, final: false, msgId: null, rid: "r_1" };
    const done = { subagent: null, final: true, msgId: "m_3", rid: "r_2" };
    const helper = { subagent: "memory", final: false, msgId: null, rid: "r_3" };
    const orphan = { subagent: null, final: true, msgId: "m_4", rid: null };
    expect(visibleStreams([live, done, helper, orphan], [], new Set(["r_2"]))).toEqual([live, done]);
    expect(visibleStreams([live, done], [{ msg_id: "m_3" }], new Set(["r_2"]))).toEqual([live]);
    expect(visibleStreams([done], [], new Set()), "no longer awaited").toEqual([]);
  });

  test("a regeneration replaces everything after the last real user turn", () => {
    const messages = [
      message("m_1", "user", [text("hi")]), message("m_2", "assistant", [toolUse("t_1")]),
      message("m_3", "user", [toolResult("t_1", "ok")]), message("m_4", "assistant", [text("done")]),
    ];
    expect(optimisticRegenReplaces(messages)).toEqual(["m_2", "m_3", "m_4"]);
    expect(optimisticRegenReplaces([message("m_1", "user")]), "an empty user turn still counts as real").toEqual([]);
    expect(regenReplaces(messages, [{ replaces: ["m_4"] }, {}], false)).toEqual(["m_4"]);
    expect(regenReplaces(messages, [{ replaces: ["m_4"] }], true)).toEqual(["m_4", "m_2", "m_3"]);
  });
});

describe("compaction", () => {
  test("a compaction in progress reads by its round until a compaction command answers after it", () => {
    const phase = (id: number, value: string, rid: string | null = null) => ({ id, type: "phase", data: { phase: value, rid } });
    const output = (id: number, name: string) => ({ id, type: "command_output", data: { name } });
    expect(compactionPhase([])).toBeNull();
    expect(compactionPhase([phase(1, "compacting context round 1")])).toBe("Compacting context…");
    expect(compactionPhase([phase(1, "compacting context round 3")])).toBe("Compacting context (round 3)…");
    expect(compactionPhase([phase(1, "compacting")])).toBe("Compacting context…");
    expect(compactionPhase([phase(1, "compacting"), phase(2, "thinking")])).toBe("Compacting context…");
    expect(compactionPhase([phase(1, "compacting", "r_1")])).toBeNull();
    for (const name of ["compact", "compact_watch", "compact_cancel"]) expect(compactionPhase([phase(1, "compacting"), output(2, name)])).toBeNull();
    expect(compactionPhase([output(1, "compact"), phase(2, "compacting")])).toBe("Compacting context…");
    expect(compactionPhase([phase(1, "compacting"), output(2, "status")])).toBe("Compacting context…");
    expect(compactionPhase([{ id: 1, type: "phase", data: "compacting" }, { id: 2, type: "phase", data: { phase: 7 } }])).toBeNull();
    expect(compactionPhase([phase(1, "compacting"), { id: 2, type: "phase", data: null }, { id: 3, type: "command_output", data: null }]), "nothing to read in an empty frame").toBe("Compacting context…");
    expect(compactionPhase([phase(1, "compacting"), output(2, "compact"), phase(3, "compacting round 2")]), "a new pass after the last ended").toBe("Compacting context (round 2)…");
  });

  const counts = { character: "ada", compacted_turns: 4, tool_rounds: 1, tools_called: [] };
  const reports: [CompactionReport, string][] = [
    [{ status: "compacted", ...counts, retained_turns: 1, memory_files_written: [], new_conversation_id: "c" }, "Summarized 4 turns and kept the last 1."],
    [{ status: "rotated", ...counts, retained_turns: 1, dry_run: false, memory_files_written: [] }, "Archived 4 turns and kept the last 1."],
    [{ status: "dry_run", ...counts, retained_turns: 1, would_write_files: 3, file_ops_preview: [] }, "Compaction would summarize 4 turns and write 3 memory files."],
    [{ status: "truncated", ...counts, truncated_turns: 2, partial_writes: [] }, "Compaction stopped early after summarizing 4 turns; 2 turns were left as they were."],
    [{ status: "segment", ...counts, segment: 6, memory_files_written: ["a.md", "b.md"] }, "Wrote memory from archived segment 6 (4 turns, 2 files)."],
    [{ status: "paused", ...counts, checkpoint_id: "k", reason: "budget", detail: null, resume_at: null }, "Compaction paused: budget."],
    [{ status: "paused", ...counts, checkpoint_id: "k", reason: "budget", detail: "monthly budget reached", resume_at: null }, "Compaction paused: monthly budget reached."],
  ];

  test("each compaction outcome is told in a sentence", () => {
    for (const [report, sentence] of reports) expect(compactionSummary(report)).toBe(sentence);
    const resumeAt = "2026-11-10T12:00:00Z";
    expect(compactionSummary({ status: "paused", ...counts, checkpoint_id: "k", reason: "budget", detail: null, resume_at: resumeAt }))
      .toBe(`Compaction paused: budget. It resumes at ${new Date(resumeAt).toLocaleTimeString()}.`);
  });

  test("watching a compaction says whether one runs and how the last one ended", () => {
    const pass = (overrides: Partial<CompactionPassEnd>): CompactionPassEnd => ({
      thread: "main", trigger: "manual", started_at: "2026-11-10T09:00:00Z", ended_at: "2026-11-10T09:05:00Z", report: null, error: null, ...overrides,
    });
    expect(compactionWatchSummary({ character: "ada", state: "finished", pass: null })).toBe("No compaction is running.");
    const report = reports[0]?.[0] ?? null;
    expect(compactionWatchSummary({ character: "ada", state: "finished", pass: pass({ report }) })).toBe("Summarized 4 turns and kept the last 1.");
    expect(compactionWatchSummary({ character: "ada", state: "finished", pass: pass({ error: "provider down" }) })).toBe("Compaction failed: provider down.");
    expect(compactionWatchSummary({ character: "ada", state: "idle", pass: pass({}) }))
      .toBe(`No compaction is running. The last one ended at ${new Date("2026-11-10T09:05:00Z").toLocaleTimeString()}: There was nothing to compact.`);
  });
});
