import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { commandCatalogue } from "../src/commands/registry.ts";
import { actionControl, CONTROL_KINDS, controlFor, initialValue } from "../src/browser/forms.ts";
import { mergeHistory, EVENT_POLICIES, inspectableRequest, touchThread, Workspace } from "../src/browser/workspace.ts";
import { sortThreads } from "../src/browser/sidebar/order.ts";
import type { ThreadView } from "../src/protocol/ThreadView.ts";
import { BrowserConnection, type BrowserRequest, type ConnectionUpdate } from "../src/browser/connection.ts";
import { ConversationRequests } from "../src/browser/chat/requests.ts";
import { blockViews, regenReplaces, replyBlocks, savedPart, visibleStreams } from "../src/browser/chat/transcript.ts";
import type { RequestFinished } from "../src/protocol/RequestFinished.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { WEB_CONTRACT, WEB_PROTOCOL } from "../src/web/contract.ts";
import type { History } from "../src/protocol/History.ts";
import { configSchema } from "../src/config/schema.ts";
import { formatConfigPath } from "../src/config/surface.ts";
import { assertSettingsCoverage, configAt, settingControl } from "../src/browser/settings_forms.ts";
import { assertModelSettingsCoverage } from "../src/browser/model_forms.ts";
import { settingSchema } from "../src/llm/settings.ts";
import { SDK_VARIANTS } from "../src/llm/types.ts";
import { assertBrowserCoverage, switchCases } from "../scripts/browser_coverage.ts";
import type { Message } from "../src/protocol/Message.ts";
import type { SegmentSummary } from "../src/protocol/SegmentSummary.ts";
import type { OperationDescriptor } from "../src/protocol/OperationDescriptor.ts";
import { assertToolControlCoverage, toolControl, toolNames } from "../src/browser/tool_forms.ts";
import { ALL_TOOLS, SUBAGENT_INPUT_SCHEMA } from "../src/tools/registry.ts";
import { OPERATION_RESULTS } from "./support/operation_results.ts";

test("built-in, subagent and connected tool schemas reach structured controls and omissions fail", () => {
  const schemas = [...ALL_TOOLS.map((tool) => ({ name: tool.name, schema: tool.parameters })), { name: "ask_worker", schema: SUBAGENT_INPUT_SCHEMA }, { name: "mcp__fixture__nested", schema: OPERATION_RESULTS.tool_results[0]?.input_schema }];
  const renderers = new Set<string>(CONTROL_KINDS);
  expect(() => assertToolControlCoverage(schemas, renderers)).not.toThrow();
  for (const kind of ["array", "object", "boolean", "string", "integer", "json", "union", "null"]) {
    expect(() => assertToolControlCoverage(schemas, new Set([...renderers].filter((renderer) => renderer !== kind)))).toThrow(`.${kind}`);
  }
  const shape = toolControl({ type: "object", properties: { query: { type: "string" }, count: { type: "integer", default: 5 } }, required: ["query"], additionalProperties: { type: "string" } });
  expect(initialValue(shape)).toEqual({ query: "" });
  expect(shape.fields["query"]).toMatchObject({ multiline: true });
  expect(shape.hints?.["count"]).toContain("Default: 5");
  expect(shape.additional).toMatchObject({ kind: "string" });
  expect(toolControl({ type: "object", additionalProperties: { type: "string" }, propertyNames: { type: "string" } }).additional).toMatchObject({ kind: "string" });
  expect(() => toolControl({ type: "object", propertyNames: { type: "string", pattern: "^field" } })).toThrow("Constrained object keys");
  expect(() => toolControl({ type: "object", patternProperties: { "^key": { type: "string" } } })).toThrow("patternProperties");
  expect(toolNames({ tools: [{ tool: "read", main: true, subagents: [] }], subagents: [{ name: "worker", enabled: false, model: null, tools: [] }], mcp: ["mcp__fixture__nested", "read"], warnings: [] })).toEqual(["ask_worker", "mcp__fixture__nested", "read"]);
});

test("live model settings cover every provider kind, including structured vendor controls", () => {
  const entries = SDK_VARIANTS.flatMap((sdk) => settingSchema(sdk));
  const renderers = new Set<string>(CONTROL_KINDS);
  expect(entries.some((entry) => entry.kind === "json_object" && entry.applicability === "honored")).toBe(true);
  expect(() => assertModelSettingsCoverage(entries, renderers)).not.toThrow();
  expect(() => assertModelSettingsCoverage(entries, new Set([...renderers].filter((kind) => kind !== "json")))).toThrow("Missing model setting renderer: json");
  expect(controlFor(true)).toEqual({ kind: "json" });
  expect(controlFor({})).toEqual({ kind: "json" });
  for (const invalid of [false, null, [], "json"]) expect(() => controlFor(invalid)).toThrow("Invalid action schema");
});

test("all live settings reach controls, with explicit failure for missing renderers or unknown kinds", () => {
  const entries = configSchema({ instancesAt: (key) => key === "mcp" ? ["fixture"] : key === "mcp.fixture.env" ? ["TOKEN"] : key === "subagents" ? ["worker"] : [] });
  const renderers = new Set<string>(CONTROL_KINDS);
  expect(entries.length).toBeGreaterThan(100);
  expect(() => assertSettingsCoverage(entries, renderers)).not.toThrow();
  expect(() => assertSettingsCoverage(entries, new Set([...renderers].filter((kind) => kind !== "integer")))).toThrow("Missing settings renderer: integer");
  const secret = entries.find((entry) => entry.key === "mcp.fixture.env.TOKEN");
  if (secret === undefined) throw new Error("Missing secret field");
  expect(secret.secret).toBe(true);
  expect(() => settingControl({ ...secret, kind: "unknown" })).toThrow("Unsupported editable setting");
  expect(configAt({ tools: { enabled_tools: ["read"] } }, "tools.enabled_tools")).toEqual(["read"]);
  expect(configAt({}, "__proto__.polluted")).toBeNull();
});

test("setting lookup follows canonical quoted configuration components", () => {
  for (const model of ["anthropic:fast-fixture", "vendor:model.v2", 'model."quoted"\\path', "", "unicode-模型", "line\nbreak"]) {
    const config = { chat: { [model]: { max_output_tokens: 4096 } } };
    const key = formatConfigPath(["chat", model, "max_output_tokens"]);
    expect(configAt(config, key)).toBe(4096);
    expect(configAt(config, formatConfigPath(["chat", model, "missing"]))).toBeNull();
  }
  expect(configAt({}, '"__proto__".polluted')).toBeNull();
  for (const key of ["chat..model", 'chat."unterminated', ".chat", "chat."]) expect(configAt({}, key)).toBeNull();
});

test("uncertain configuration requests retain their key and hide submitted values", () => {
  const request = { type: "command", name: "config", args: { key: "notifications.ntfy.token", value: "private-secret" } } as const;
  expect(inspectableRequest(request)).toEqual({ ...request, args: { key: "notifications.ntfy.token", value: "<redacted>" } });
  expect(request.args.value).toBe("private-secret");
});

test("every registered action field reaches an implemented control, and every known event has a handler", async () => {
  const workspace = await readFile(new URL("../src/browser/workspace.ts", import.meta.url), "utf8");
  const renderers = new Set<string>(CONTROL_KINDS);
  const events = await switchCases(workspace, "#receive", "message.type");
  const operations: OperationDescriptor[] = commandCatalogue();
  expect(() => assertBrowserCoverage(operations, renderers, events)).not.toThrow();
  const omittedRenderer = new Set([...renderers].filter((kind) => kind !== "integer"));
  expect(() => assertBrowserCoverage(operations, omittedRenderer, events)).toThrow("Missing GUI control renderer: integer");
  const omittedEvent = await switchCases(workspace.replace('case "send_image":', ""), "#receive", "message.type");
  expect(() => assertBrowserCoverage(operations, renderers, omittedEvent)).toThrow("Missing GUI event handling: send_image");
  const { tool_call: _omitted, ...policies } = EVENT_POLICIES;
  expect(() => assertBrowserCoverage(operations, renderers, events, policies)).toThrow("Missing GUI event handling: tool_call");
  const fork = operations.find((operation) => operation.name === "fork_thread");
  if (fork === undefined) throw new Error("Missing fork action");
  const { turns: _turns, ...fields } = fork.fields;
  expect(() => actionControl({ ...fork, fields })).toThrow("Unaccounted GUI fields: fork_thread");
  expect(() => controlFor({ type: "string", format: "date", pattern: "pattern-needing-a-renderer" })).toThrow("Unsupported action schema keyword: pattern");
  expect(controlFor({ type: "object", additionalProperties: true })).toMatchObject({ kind: "object", additional: { kind: "json" } });
  expect(initialValue(actionControl(fork))).toEqual({ name: "" });
});

const message = (id: string): Message => ({ msg_id: id, role: "user", content: id, images: [], content_blocks: [], timestamp: "now" });

test("a dropped request's notice clears when its outcome arrives, and a failure is reported", () => {
  class Connection extends BrowserConnection {
    listeners = new Set<(update: ConnectionUpdate) => void>();
    override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    emit(update: ConnectionUpdate) { for (const listener of this.listeners) listener(update); }
  }
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const workspace = new Workspace(connection);
  const selection = { character: "nova", thread: "main", messageRevision: 0, snapshotRevision: 0 };
  for (const rid of ["sent", "compacted"]) connection.emit({ kind: "uncertain", rid, request: { type: "command", name: "compact", args: {} }, selection });
  expect(workspace.getSnapshot().uncertain.map((item) => item.rid)).toEqual(["sent", "compacted"]);
  connection.emit({ kind: "frame", message: { type: "request_finished", rid: "sent", outcome: "completed" } });
  expect(workspace.getSnapshot().uncertain.map((item) => item.rid)).toEqual(["compacted"]);
  expect(workspace.getSnapshot().error).toBe("");
  connection.emit({ kind: "frame", message: { type: "request_finished", rid: "compacted", outcome: "failed", error: { code: "provider_error", message: "overloaded" } } });
  expect(workspace.getSnapshot().uncertain).toEqual([]);
  expect(workspace.getSnapshot().error).toBe("overloaded");
});

test("a regeneration started in another client hides exactly the messages its stream_start lists", () => {
  class Connection extends BrowserConnection {
    listeners = new Set<(update: ConnectionUpdate) => void>();
    override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    frame(frame: ServerMessage) { for (const listener of this.listeners) listener({ kind: "frame", message: frame }); }
  }
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const workspace = new Workspace(connection);
  const reply = (id: string): Message => ({ ...message(id), role: "assistant" });
  connection.frame({ type: "history", config: {}, revision: 1, selected_character: "nova", selected_thread: "main", messages: [message("question"), reply("kept"), reply("old")] });
  const hidden = () => {
    const state = workspace.getSnapshot();
    return regenReplaces(state.messages, visibleStreams(state.streams, state.messages, new Set()), false);
  };
  connection.frame({ type: "stream_start", rid: "elsewhere", regen: false });
  expect(hidden()).toEqual([]);
  connection.frame({ type: "stream_start", rid: "regen", regen: true, replaces: ["old"] });
  expect(hidden()).toEqual(["old"]);
  connection.frame({ type: "stream_chunk", rid: "regen", content_type: "text", text: "new" });
  connection.frame({ type: "stream_start", rid: "regen", regen: true, replaces: ["old"] });
  expect(hidden()).toEqual(["old"]);
});

test("a tool loop's saved rounds and its live stream show each step once", () => {
  class Connection extends BrowserConnection {
    listeners = new Set<(update: ConnectionUpdate) => void>();
    override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    frame(frame: ServerMessage) { for (const listener of this.listeners) listener({ kind: "frame", message: frame }); }
  }
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const workspace = new Workspace(connection);
  const saved = (id: string, revision: number, ...content_blocks: Message["content_blocks"]): ServerMessage => ({ type: "history", config: {}, revision, selected_character: "nova", selected_thread: "main", delta: { base_revision: revision - 1, after: "question" }, messages: [{ ...message(id), role: "assistant", content_blocks }] });
  const use = { type: "tool_use" as const, id: "t1", name: "read", input: { path: "notes.md" } };
  const result = { type: "tool_result" as const, tool_use_id: "t1", content: "contents" };
  const shown = () => {
    const state = workspace.getSnapshot();
    const [stream] = visibleStreams(state.streams, state.messages, new Set(["r1"]));
    if (stream === undefined) return state.messages.map((item) => item.msg_id);
    const part = savedPart(state.messages, stream);
    const rest = state.messages.filter((item) => item !== part).map((item) => item.msg_id);
    return [...rest, blockViews(replyBlocks(stream, part)).map((view) => view.kind === "tool" ? `${view.id}:${view.output ?? "running"}` : view.kind === "thinking" ? `thinking:${view.text}` : view.kind === "text" ? `text:${view.text}` : view.kind)];
  };
  connection.frame({ type: "history", config: {}, revision: 1, selected_character: "nova", selected_thread: "main", messages: [message("question")] });
  connection.frame({ type: "stream_start", rid: "r1", regen: false });
  connection.frame({ type: "stream_chunk", rid: "r1", content_type: "thinking", text: "Looking" });
  expect(shown()).toEqual(["question", ["thinking:Looking"]]);
  connection.frame(saved("round-1", 2, { type: "thinking", thinking: "Looking" }, use));
  expect(shown()).toEqual(["question", ["thinking:Looking", "t1:running"]]);
  connection.frame({ type: "tool_call", rid: "r1", tool_id: "t1", tool_name: "read", input: { path: "notes.md" } });
  connection.frame({ type: "tool_result", rid: "r1", tool_id: "t1", tool_name: "read", output: "contents", is_error: false });
  expect(shown()).toEqual(["question", ["thinking:Looking", "t1:contents"]]);
  connection.frame(saved("round-1", 3, { type: "thinking", thinking: "Looking" }, use, result));
  connection.frame({ type: "stream_chunk", rid: "r1", content_type: "thinking", text: "Checking" });
  connection.frame({ type: "stream_chunk", rid: "r1", content_type: "text", text: "All done." });
  expect(shown()).toEqual(["question", ["thinking:Looking", "t1:contents", "thinking:Checking", "text:All done."]]);
  connection.frame({ type: "stream_end", rid: "r1", msg_id: "final", content: "All done.", terminal_content_blocks: [{ type: "thinking", thinking: "Checking" }, { type: "text", text: "All done." }], finish_reason: "end_turn", is_final: true, metadata: { model: "m", tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, timing: { total_ms: 1, ttft_ms: 1 } } });
  expect(shown()).toEqual(["question", ["thinking:Looking", "t1:contents", "thinking:Checking", "text:All done."]]);
  connection.frame(saved("final", 4, { type: "thinking", thinking: "Looking" }, use, result, { type: "thinking", thinking: "Checking" }, { type: "text", text: "All done." }));
  expect(shown()).toEqual(["question", "final"]);
});

test("streamed chunks reach the screen once per frame while every other event reaches it at once", () => {
  class Connection extends BrowserConnection {
    listeners = new Set<(update: ConnectionUpdate) => void>();
    override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    frame(frame: ServerMessage) { for (const listener of this.listeners) listener({ kind: "frame", message: frame }); }
  }
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const frames: (() => void)[] = [];
  const workspace = new Workspace(connection, (callback) => { frames.push(callback); });
  let notified = 0;
  workspace.subscribe(() => { notified += 1; });
  const chunk = (text: string): ServerMessage => ({ type: "stream_chunk", rid: "r1", content_type: "text", text });
  connection.frame({ type: "stream_start", rid: "r1", regen: false });
  const started = notified;
  expect(started).toBeGreaterThan(0);
  for (const text of ["a", "b", "c"]) connection.frame(chunk(text));
  expect(workspace.getSnapshot().streams.map((stream) => stream.text)).toEqual(["abc"]);
  expect(notified).toBe(started);
  expect(frames).toHaveLength(1);
  frames[0]?.();
  expect(notified).toBe(started + 1);
  connection.frame(chunk("d"));
  expect(frames).toHaveLength(2);
  connection.frame({ type: "stream_end", rid: "r1", msg_id: "final", content: "abcd", finish_reason: "end_turn", is_final: true, metadata: { model: "m", tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, timing: { total_ms: 1, ttft_ms: 1 } } });
  const ended = notified;
  expect(ended).toBeGreaterThan(started + 1);
  frames[1]?.();
  expect(notified).toBe(ended);
});

test("history-only updates retain configuration until it is replaced or the conversation changes", () => {
  class Connection extends BrowserConnection {
    listeners = new Set<(update: ConnectionUpdate) => void>();
    override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    history(history: History) { for (const listener of this.listeners) listener({ kind: "frame", message: { type: "history", ...history } }); }
  }
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const workspace = new Workspace(connection);
  const history: History = { messages: [], config: { chat: { model: "fixture" } }, selected_character: "nova", selected_thread: "main", revision: 1 };
  connection.history(history);
  expect(workspace.getSnapshot().config).toEqual(history.config);
  connection.history({ ...history, config: {}, messages: [message("question")], revision: 2, delta: { base_revision: 1, after: null } });
  expect(workspace.getSnapshot().config).toEqual(history.config);
  expect(workspace.getSnapshot().messages.map((item) => item.msg_id)).toEqual(["question"]);
  connection.history({ ...history, config: {}, messages: [message("edited")], revision: 3 });
  expect(workspace.getSnapshot().config).toEqual(history.config);
  expect(workspace.getSnapshot().messages.map((item) => item.msg_id)).toEqual(["edited"]);
  const updated = { chat: { model: "updated" } };
  connection.history({ ...history, config: updated, revision: 4 });
  expect(workspace.getSnapshot().config).toEqual(updated);
  connection.history({ ...history, config: {}, selected_thread: "side" });
  expect(workspace.getSnapshot().config).toEqual({});
  connection.history(history);
  connection.history({ ...history, config: {}, selected_character: "other" });
  expect(workspace.getSnapshot().config).toEqual({});
  connection.history({ ...history, config: updated });
  expect(workspace.getSnapshot().config).toEqual(updated);
});

test("conversation requests track when the daemon saved the message and when the reply started streaming", async () => {
  class Connection extends BrowserConnection {
    listeners = new Set<(update: ConnectionUpdate) => void>();
    finish = new Map<string, (result: RequestFinished) => void>();
    override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    override submit(_request: BrowserRequest, rid = `r${String(this.finish.size + 1)}`) {
      return { rid, finished: new Promise<RequestFinished>((resolve) => { this.finish.set(rid, resolve); }) };
    }
    frame(event: ServerMessage) { for (const listener of this.listeners) listener({ kind: "frame", message: event }); }
  }
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const requests = new ConversationRequests(connection);
  const accepted: string[] = [];
  const sent = requests.submit("message", { stream: true, text: "hello", image_data: [] }, { rid: "r1", accepted: () => accepted.push("r1") });
  const regen = requests.submit("regen", { stream: true });
  const echo = (rid: string, role: "user" | "assistant"): ServerMessage => ({ type: "new_message", revision: 1, rid, msg_id: `${role}-${rid}`, role, content: "hello", images: [], content_blocks: [], timestamp: "now" });
  connection.frame(echo("r1", "assistant"));
  connection.frame(echo("r1", "user"));
  connection.frame({ type: "request_accepted", rid: "other" });
  expect(accepted).toEqual([]);
  connection.frame({ type: "request_accepted", rid: "r1" });
  connection.frame({ type: "request_accepted", rid: "r1" });
  expect(accepted).toEqual(["r1"]);
  expect(requests.pendingRegens()).toEqual(["r2"]);
  expect(requests.pendingRegens({ character: null, thread: null })).toEqual(["r2"]);
  expect(requests.pendingRegens({ character: "ada", thread: "side" })).toEqual([]);
  expect(requests.regens({ character: null, thread: null })).toEqual(["r2"]);
  expect(requests.awaitingStream({ character: "ada", thread: "side" })).toBeUndefined();
  expect(requests.awaitingStream()).toBe("r1");
  connection.frame({ type: "stream_start", rid: "r1", regen: false, subagent: null });
  expect(requests.awaitingStream()).toBe("r2");
  connection.frame({ type: "stream_start", rid: "r2", regen: true, subagent: "worker" });
  expect(requests.pendingRegens()).toEqual(["r2"]);
  const before = requests.getSnapshot();
  connection.frame({ type: "stream_start", rid: "r2", regen: true, subagent: null });
  expect(requests.pendingRegens()).toEqual([]);
  expect(requests.awaitingStream()).toBeUndefined();
  expect(requests.getSnapshot()).not.toBe(before);
  connection.finish.get("r1")?.({ rid: "r1", outcome: "completed" });
  connection.finish.get("r2")?.({ rid: "r2", outcome: "cancelled" });
  await Promise.all([sent, regen]);
  expect(requests.getSnapshot().size).toBe(0);
});

test("history deltas replace the suffix and detect absent anchors", () => {
  const previous = [message("opening"), message("question"), message("old-answer")];
  const history = { messages: [message("new-answer")], config: {}, revision: 2, delta: { base_revision: 1, after: "question" } };
  expect(mergeHistory(previous, history)?.map((item) => item.msg_id)).toEqual(["opening", "question", "new-answer"]);
  expect(mergeHistory(previous, { ...history, delta: { ...history.delta, after: null } })?.map((item) => item.msg_id)).toEqual(["new-answer"]);
  expect(mergeHistory(previous, { ...history, delta: { ...history.delta, after: "missing" } })).toBeUndefined();
  expect(mergeHistory(previous, { messages: [message("whole")], config: {}, revision: 3 })?.map((item) => item.msg_id)).toEqual(["whole"]);
});

test("a segment view pages one archived segment at a time and leaves the live conversation alone", async () => {
  class Connection extends BrowserConnection {
    listeners = new Set<(update: ConnectionUpdate) => void>();
    override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    frame(frame: ServerMessage) { for (const listener of this.listeners) listener({ kind: "frame", message: frame }); }
  }
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const workspace = new Workspace(connection);
  const summary = (index: number): SegmentSummary => ({ index, first_message_at: null, last_message_at: null, compacted_at: "2026-10-01T00:00:00Z", message_count: 2, excluded: false, label: null, note: null, memory_before: null, memory_after: null });
  let latest = 1;
  const calls: unknown[] = [];
  workspace.actions.run = (async (name: string, input: Record<string, unknown>) => {
    calls.push([name, input]);
    await Promise.resolve();
    const index = input["segment"] as number;
    const early = input["before"] === 10;
    const messages = input["count"] === 0 ? [] : early ? [message(`s${String(index)}-early`)] : [message(`s${String(index)}-a`), message(`s${String(index)}-b`)];
    const cursor = early ? 8 : 10;
    return { messages, cursor, next_before: cursor, has_more_before: index === 1 && !early, total_turns: 2, segment: summary(index), previous_segment: index > 0 ? summary(index - 1) : null, next_segment: index < latest ? summary(index + 1) : null };
  }) as never;
  const view = () => workspace.getSnapshot().segmentView;
  const live = { type: "history" as const, config: {}, selected_character: "nova", selected_thread: "main" };
  const settle = async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); };

  connection.frame({ ...live, revision: 1, messages: [message("live")], previous_segment: summary(1) });
  expect(workspace.getSnapshot().previousSegment?.index).toBe(1);
  expect(view()).toBeNull();

  await workspace.openOlder();
  expect(calls.at(-1)).toEqual(["history_page", { segment: 1, turns: 32 }]);
  expect(view()?.segment.index).toBe(1);
  expect(view()?.messages.map((item) => item.msg_id)).toEqual(["s1-a", "s1-b"]);
  expect([view()?.previous?.index, view()?.next, view()?.hasEarlier, view()?.seenLive]).toEqual([0, null, true, "live"]);

  await workspace.loadEarlierInSegment();
  expect(calls.at(-1)).toEqual(["history_page", { segment: 1, before: 10, turns: 32 }]);
  expect(view()?.messages.map((item) => item.msg_id)).toEqual(["s1-early", "s1-a", "s1-b"]);
  expect(view()?.hasEarlier).toBe(false);
  const asked = calls.length;
  await workspace.loadEarlierInSegment();
  expect(calls).toHaveLength(asked);

  await workspace.openOlder();
  expect([view()?.segment.index, view()?.previous, view()?.next?.index]).toEqual([0, null, 1]);
  await workspace.openOlder();
  expect(view()?.segment.index).toBe(0);
  await workspace.openNewer();
  expect(view()?.segment.index).toBe(1);
  await workspace.openNewer();
  expect(view()).toBeNull();
  expect(workspace.getSnapshot().messages.map((item) => item.msg_id)).toEqual(["live"]);

  await workspace.openSegment(1);
  connection.frame({ ...live, revision: 2, messages: [message("reply")], delta: { base_revision: 1, after: "live" } });
  expect(view()?.segment.index).toBe(1);
  expect(workspace.getSnapshot().messages.map((item) => item.msg_id)).toEqual(["live", "reply"]);
  connection.frame({ ...live, revision: 3, messages: [message("reply")], previous_segment: summary(1) });
  await settle();
  expect(calls.at(-1)).not.toEqual(["history_page", { segment: 1, count: 0 }]);
  latest = 2;
  connection.frame({ ...live, revision: 4, messages: [message("kept")], previous_segment: summary(2) });
  await settle();
  expect(calls.at(-1)).toEqual(["history_page", { segment: 1, count: 0 }]);
  expect([view()?.segment.index, view()?.next?.index, view()?.messages.length]).toEqual([1, 2, 2]);

  const superseded = workspace.openSegment(0);
  workspace.closeSegment();
  await superseded;
  expect(view()).toBeNull();

  await workspace.openSegment(1);
  connection.frame({ ...live, revision: 5, messages: [], selected_thread: "side" });
  expect(view()).toBeNull();
  expect(workspace.getSnapshot().previousSegment).toBeNull();
  workspace.closeSegment();
  expect(view()).toBeNull();
});

test("history deltas retain image bytes omitted by the daemon's incremental frames", () => {
  const previous = [{ ...message("image"), images: [{ path: "stable.png", data: "aW1hZ2U=" }] }];
  const history = { messages: [{ ...message("image"), images: [{ path: "stable.png" }] }], config: {}, revision: 2, delta: { base_revision: 1, after: null } };
  expect(mergeHistory(previous, history)?.at(0)?.images).toEqual([{ path: "stable.png", data: "aW1hZ2U=" }]);
  expect(mergeHistory(previous, { ...history, messages: [{ ...message("image"), images: [{ path: "stable.png", data: "bmV3" }] }] })?.at(0)?.images).toEqual([{ path: "stable.png", data: "bmV3" }]);
});

test("a turn in an older thread lists it above threads created after it, with home still first", () => {
  const thread = (id: string, created_at: string, home = false): ThreadView => ({ id, created_at, compaction: false, home, current: false });
  const threads = [thread("main", "2026-09-01T00:00:00.000Z", true), thread("old", "2026-09-02T00:00:00.000Z"), thread("new", "2026-09-03T00:00:00.000Z")];
  expect(sortThreads(threads).map((item) => item.id)).toEqual(["main", "new", "old"]);
  const reply = (character: string, timestamp: string): Extract<ServerMessage, { type: "new_message" }> => ({ type: "new_message", revision: 1, character, thread: "old", msg_id: "a1", role: "assistant", content: "hi", images: [], content_blocks: [], timestamp });
  const touched = touchThread(threads, "nova", reply("nova", "2026-09-04T09:00:00+10:00"));
  expect(touched.find((item) => item.id === "old")?.last_active).toBe("2026-09-03T23:00:00.000Z");
  expect(touched.find((item) => item.id === "new")).not.toHaveProperty("last_active");
  expect(sortThreads(touched).map((item) => item.id)).toEqual(["main", "old", "new"]);
  expect(touchThread(threads, "nova", reply("ada", "2026-09-04T09:00:00+10:00"))).toBe(threads);
  expect(touchThread(threads, "nova", reply("nova", "now"))).toBe(threads);
});

test("a reply that arrives while the sidebar is open moves its thread up", async () => {
  class Connection extends BrowserConnection {
    listeners = new Set<(update: ConnectionUpdate) => void>();
    override subscribe(listener: (update: ConnectionUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    frame(frame: ServerMessage) { for (const listener of this.listeners) listener({ kind: "frame", message: frame }); }
  }
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const workspace = new Workspace(connection);
  const thread = (id: string, created_at: string): ThreadView => ({ id, created_at, compaction: false, home: id === "main", current: false });
  const listed = [thread("main", "2026-09-01T00:00:00.000Z"), thread("old", "2026-09-02T00:00:00.000Z"), thread("new", "2026-09-03T00:00:00.000Z")];
  workspace.actions.run = (async (name: string) => {
    await Promise.resolve();
    if (name === "discover_operations") return { operations: [{ name: "list_threads", available: true }], requests: [] };
    if (name === "list_characters") return { characters: [] };
    return { threads: listed };
  }) as never;
  await workspace.refreshNavigation();
  connection.frame({ type: "history", config: {}, revision: 1, selected_character: "nova", selected_thread: "old", messages: [] });
  connection.frame({ type: "new_message", revision: 2, character: "nova", thread: "old", msg_id: "a1", role: "assistant", content: "hi", images: [], content_blocks: [], timestamp: "2026-09-04T09:00:00+10:00" });
  expect(sortThreads(workspace.getSnapshot().threads).map((item) => item.id)).toEqual(["main", "old", "new"]);
});
