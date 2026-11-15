import { describe, expect, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const DAY = "2026-11-10T00:00:00Z";
const settle = async () => { await acting(() => Bun.sleep(5)); };
const usage = { input_tokens: 1200, output_tokens: 34, cache_read_tokens: 5, cache_write_tokens: 6 };
const summary = (id: number, extra: Record<string, unknown> = {}) => ({
  id, call_id: `c${String(id)}`, ts: DAY, call_type: "message", character: "ada", model: "opus", provider: "anthropic", finish_reason: "end_turn", usage, duration_ms: 2500, error: null, request_bytes: 100, response_bytes: 200, ...extra,
});
const inspection = (id: number, call: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ enabled: true, call: { ...summary(id), request: { messages: [] }, response: "plain text", ...call }, wire: [], ...extra });
const exchange = (id: number, extra: Record<string, unknown> = {}) => ({
  id, call_id: "c7", seq: id, ts: DAY, character: "ada", call_type: "message", rid: null, method: "POST", url: "https://api.example/v1", status: 200, status_text: "OK", duration_ms: 10, error: null,
  request_bytes: 1, response_bytes: 2, request_headers: [["accept", "json"]], response_headers: [], request_body: { x: 1 }, response_body: "ok", ...extra,
});
const message = (id: string, role: string, content: string) => ({ msg_id: id, role, content, images: [], content_blocks: [], timestamp: DAY });
const page = (messages: unknown[], total: number) => ({ messages, cursor: 0, next_before: 0, has_more_before: false, total_turns: total, segment: null, previous_segment: null, next_segment: null });
const transcript = (source: string, entries: unknown[], enabled = true) => ({ enabled, source, entries });
const row = (id: number, extra: Record<string, unknown> = {}) => ({ id, ts: DAY, source: "heartbeat", character: "ada", call_type: "heartbeat", iteration: 2, model: "opus", provider: "anthropic", finish_reason: "end_turn", usage, entry: { said: "hello" }, ...extra });
const trace = (extra: Record<string, unknown> = {}) => ({ ts: DAY, subagent: "helper", parent_tool_use_id: "toolu_1", model: "haiku", messages: [], ...extra });

async function traces(character: string | null = "ada", thread: string | null = "story") {
  const { TracesPage } = await import("../../src/browser/settings/Traces.tsx");
  const state = { ...app.state().workspace.getSnapshot(), character, thread };
  const view = await mount(<TracesPage state={state} />);
  await settle();
  return { ...view, thread: async (next: string) => { await view.update(<TracesPage state={{ ...state, thread: next }} />); await settle(); } };
}

async function formats() {
  const { formatTime } = await import("../../src/browser/settings/shared.tsx");
  return formatTime;
}

function reply(name: string, data: unknown) {
  const held = app.socket().sent.filter((request) => request["name"] === name).at(-1);
  app.socket().receive({ type: "command_output", rid: held?.["rid"], name, data });
  app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
}

const asked = (since: number) => app.sent(since).filter((request) => request["type"] === "command").map((request) => [request["name"], request["args"]]);
const cells = (root: ParentNode, selector = "table") => [...root.querySelectorAll(`${selector} tbody tr`)].map((item) => [...item.querySelectorAll("td")].map((cell) => cell.className === "" ? cell.textContent : [cell.textContent, cell.className]));
const options = (select: Element | null) => [...select?.querySelectorAll("option") ?? []].map((option) => [option.getAttribute("value"), option.textContent]);
const empty = (root: ParentNode) => [...root.querySelectorAll(".settings-section .settings-empty")].map((note) => note.textContent);
const tab = async (root: ParentNode, name: string) => { await click(button(root, name)); await settle(); };

describe("the traces page", () => {
  test("needs a character, then reads only the kind of trace chosen", async () => {
    const before = app.socket().sent.length;
    app.answer((request) => request["name"] === "list_threads" || request["name"] === "discover_operations" || request["name"] === "list_characters" ? undefined : HOLD);
    const none = await traces(null);
    expect([none.host.textContent, asked(before)]).toEqual(["Choose a character in the sidebar first; these settings belong to a character.", []]);
    const view = await traces();
    expect(view.host.querySelector(":scope > .settings-description")?.textContent).toBe("Stored diagnostics for ada: model calls, background activity and errors.");
    const names = ["Model calls", "Thread log", "Wake transcript", "Dream transcript", "Wake events", "Errors", "Subagents"];
    const selected = () => names.map((name) => [button(view.host, name).getAttribute("aria-selected"), button(view.host, name).getAttribute("aria-checked")].join());
    expect(selected()).toEqual(["true,true", ...names.slice(1).map(() => "false,false")]);
    const reads: unknown[] = [asked(before)];
    for (const name of names.slice(1)) {
      const since = app.socket().sent.length;
      await tab(view.host, name);
      reads.push(asked(since));
    }
    expect(selected().at(-1)).toBe("true,true");
    expect(reads).toEqual([
      [["call_log", { count: 25 }]], [["log", { turns: 10 }]], [["transcript", { count: 25 }]], [["transcript", { count: 25, source: "dreaming" }]],
      [["heartbeat_log", { count: 25 }]], [["error_log", { count: 25 }]], [["subagent_trace", { count: 25 }]],
    ]);
  });

  test("model calls are listed by count and type, saying when logging is off", async () => {
    const time = await formats();
    const answers: unknown[] = [
      { enabled: true, entries: [summary(7), summary(8, { call_type: null, model: null, error: "overloaded", duration_ms: null }), summary(9, { finish_reason: null })] },
      { enabled: false, entries: [] },
      inspection(1),
    ];
    app.answer((request) => request["name"] === "call_log" ? answers.shift() : undefined);
    const before = app.socket().sent.length;
    const view = await traces();
    const count = view.host.querySelector("select[aria-label='Entries to show']");
    const kind = view.host.querySelector("select[aria-label='Call type']");
    expect([options(count), (count as HTMLSelectElement | null)?.value]).toEqual([[["10", "Last 10"], ["25", "Last 25"], ["50", "Last 50"], ["100", "Last 100"]], "25"]);
    expect(options(kind)).toEqual([["", "All call types"], ...["message", "wake", "compaction", "dreaming", "subagent", "keepalive"].map((name) => [name, name])]);
    expect([...view.host.querySelectorAll("thead th")].map((cell) => [cell.textContent, cell.className])).toEqual([["#", "number"], ["When", ""], ["Type", ""], ["Model", ""], ["In", "number"], ["Out", "number"], ["ms", "number"], ["Result", ""]]);
    const n = (value: number) => [value.toLocaleString(), "number"];
    expect(cells(view.host)).toEqual([
      [n(7), time(DAY), "message", ["opus", "mono"], n(1200), n(34), n(2500), "end_turn"],
      [n(8), time(DAY), "—", ["—", "mono"], n(1200), n(34), ["—", "number"], ["overloaded", "form-error"]],
      [n(9), time(DAY), "message", ["opus", "mono"], n(1200), n(34), n(2500), "—"],
    ]);
    expect([empty(view.host), [...view.host.querySelectorAll("tbody tr")].map((item) => [item.className, item.getAttribute("tabindex")])[0]]).toEqual([[], ["clickable", "0"]]);
    await type(count, "50");
    await settle();
    expect(empty(view.host)).toEqual(["Call logging is off. Enable diagnostics.call_log in the configuration."]);
    await type(kind, "wake");
    await settle();
    expect([view.host.querySelector(".settings-empty [role=status]") !== null, view.host.querySelector("tbody")], "an answer that is not a listing shows nothing yet").toEqual([true, null]);
    expect(asked(before)).toEqual([["call_log", { count: 25 }], ["call_log", { count: 50 }], ["call_log", { count: 50, call_type: "wake" }]]);
  });

  test("a call opens from its row, by click or Enter, with what it sent, got back and cost", async () => {
    const time = await formats();
    let detail: (args: Record<string, unknown>) => unknown = () => HOLD;
    app.answer((request) => {
      if (request["name"] !== "call_log") return undefined;
      const args = request["args"] as Record<string, unknown>;
      return args["id"] === undefined ? { enabled: true, entries: [summary(7), summary(8)] } : detail(args);
    });
    const view = await traces();
    const rows = [...view.host.querySelectorAll("tbody tr")];
    await acting(() => { rows[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); });
    expect(view.host.querySelector("dialog")).toBeNull();
    const opening = app.socket().sent.length;
    await click(rows[0]);
    const dialog = () => view.host.querySelector("dialog");
    expect([dialog()?.querySelector("h2")?.textContent, dialog()?.querySelector("[aria-label='Loading call']") !== null, asked(opening)]).toEqual(["Call 7", true, [["call_log", { id: 7 }]]]);
    reply("call_log", inspection(7, {}, { wire: [exchange(1), exchange(2, { status: null, request_headers: undefined, response_headers: undefined, request_body: undefined, response_body: undefined })] }));
    await settle();
    const facts = () => [...dialog()?.querySelectorAll(".kv-row") ?? []].map((item) => [item.querySelector("dt")?.textContent, item.querySelector("dd")?.textContent, item.querySelector("dd")?.className]);
    expect(facts()).toEqual([
      ["When", time(DAY), ""], ["Model", "anthropic:opus", "mono"], ["Type", "message · end_turn", ""],
      ["Tokens", `${(1200).toLocaleString()} in · 34 out · 5 cache read · 6 cache write`, ""], ["Duration", `${(2500).toLocaleString()} ms`, ""],
    ]);
    const payloads = () => [...dialog()?.querySelectorAll("details.payload") ?? []].map((item) => [item.querySelector("summary")?.textContent, item.querySelector("pre")?.textContent]);
    expect(payloads()).toEqual([
      ["Request (100 bytes)", JSON.stringify({ messages: [] }, null, 2)], ["Response (200 bytes)", "plain text"],
      ["HTTP POST https://api.example/v1 → 200", JSON.stringify({ request_headers: [["accept", "json"]], request_body: { x: 1 }, response_headers: [], response_body: "ok" }, null, 2)],
      ["HTTP POST https://api.example/v1 → no status", "{}"],
    ]);
    expect(dialog()?.querySelector(".rows.padded")).toBeNull();
    const before = app.socket().sent.length;
    const compare = dialog()?.querySelector<HTMLInputElement>("input[aria-label='Compare with call']");
    await type(compare, "1a2");
    expect(compare?.value).toBe("12");
    detail = () => HOLD;
    await click(button(view.host, "Compare"));
    expect([button(view.host, "Compare").disabled, button(view.host, "Reload").disabled]).toEqual([true, true]);
    reply("call_log", inspection(7, { provider: null, model: null, call_type: null, finish_reason: null, duration_ms: null, error: "rate limited" }, { diff: {
      from_payload: 1, to_payload: 2, from_call: 12, to_call: 7, source: "internal", chunks: { equal: 5, added: 1, removed: 1 }, bytes: { equal: 1, added: 1, removed: 1 },
      entries: [{ op: "equal", hash: "h0", bytes: 3, text: "same" }, { op: "added", hash: "h1", bytes: 4, text: "new" }, { op: "removed", hash: "h2", bytes: 9, text: null }],
    } }));
    await settle();
    expect([button(view.host, "Compare").disabled, button(view.host, "Reload").disabled]).toEqual([false, false]);
    expect(facts()).toEqual([
      ["When", time(DAY), ""], ["Model", ":unknown", "mono"], ["Type", "— · no finish reason", ""],
      ["Tokens", `${(1200).toLocaleString()} in · 34 out · 5 cache read · 6 cache write`, ""], ["Duration", "—", ""], ["Error", "rate limited", "form-error"],
    ]);
    const compared = dialog()?.querySelector(".rows.padded");
    expect([compared?.querySelector(".setting-label")?.textContent, compared?.querySelector(".setting-description")?.textContent, compared?.querySelector("pre")?.textContent]).toEqual(["Compared with call 12", "5 unchanged, 1 added, 1 removed chunks", "+ new\n- (9 bytes)"]);
    detail = () => inspection(7);
    await click(dialog()?.querySelector("input[type=checkbox]"));
    await click(button(view.host, "Reload"));
    await settle();
    await type(compare, "");
    await click(button(view.host, "Compare"));
    await settle();
    await click(dialog()?.querySelector("input[type=checkbox]"));
    detail = () => ({ enabled: true, entries: [] });
    await click(button(view.host, "Reload"));
    await settle();
    expect(facts()[1], "an answer that is not a call leaves the last one").toEqual(["Model", "anthropic:opus", "mono"]);
    expect(asked(before)).toEqual([
      ["call_log", { id: 7, diff: true, against: 12 }], ["call_log", { id: 7, wire: true }], ["call_log", { id: 7, wire: true, diff: true }], ["call_log", { id: 7 }],
    ]);
    await click(button(view.host, "Close"));
    expect(dialog()).toBeNull();
    detail = () => inspection(8);
    await acting(() => { rows[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await settle();
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Call 8");
  });

  test("the thread log reads the last turns by role, again when the thread changes", async () => {
    const time = await formats();
    app.answer((request) => request["name"] === "log" ? page([message("m_1", "user", "hi **there**"), message("m_2", "assistant", "hello")], 1234) : undefined);
    const view = await traces();
    const before = app.socket().sent.length;
    await tab(view.host, "Thread log");
    const turns = view.host.querySelector("select[aria-label=Turns]");
    const role = view.host.querySelector("select[aria-label=Role]");
    expect([options(turns), (turns as HTMLSelectElement | null)?.value, options(role)]).toEqual([
      [["5", "Last 5 turns"], ["10", "Last 10 turns"], ["25", "Last 25 turns"], ["50", "Last 50 turns"]], "10",
      [["", "All roles"], ["user", "You"], ["assistant", "Character"], ["system", "System"]],
    ]);
    expect(view.host.querySelector(".settings-section .setting-description")?.textContent).toBe(`${(1234).toLocaleString()} turns in the current context.`);
    expect([...view.host.querySelectorAll(".segment-message")].map((item) => [item.querySelector(".setting-label")?.textContent, item.querySelector("strong")?.textContent ?? null])).toEqual([[`user · ${time(DAY)}`, "there"], [`assistant · ${time(DAY)}`, null]]);
    await type(turns, "25");
    await type(role, "assistant");
    await view.thread("side");
    expect(asked(before)).toEqual([["log", { turns: 10 }], ["log", { turns: 25 }], ["log", { turns: 25, role: "assistant" }], ["log", { turns: 25, role: "assistant" }]]);
  });

  test("wake and dream transcripts show each round, or say they are off or empty", async () => {
    const time = await formats();
    const answers: Record<string, unknown[]> = {
      heartbeat: [transcript("heartbeat", [row(1), row(2, { model: null, finish_reason: null })]), transcript("heartbeat", [], false), transcript("heartbeat", [row(3)])],
      dreaming: [transcript("dreaming", [row(4, { source: "dreaming", iteration: 1 })]), transcript("dreaming", [], false)],
    };
    app.answer((request) => request["name"] === "transcript" ? answers[(request["args"] as { source?: string }).source ?? "heartbeat"]?.shift() : undefined);
    const view = await traces();
    const before = app.socket().sent.length;
    const rounds = () => [...view.host.querySelectorAll(".settings-section details.payload")].map((item) => [item.querySelector("summary")?.textContent, item.querySelector("dd")?.textContent]);
    await tab(view.host, "Wake transcript");
    expect([rounds(), empty(view.host)]).toEqual([[[`${time(DAY)} · round 2 · opus · end_turn`, "hello"], [`${time(DAY)} · round 2 · ? · `, "hello"]], []]);
    const count = () => view.host.querySelector("select[aria-label='Entries to show']");
    await type(count(), "10");
    await settle();
    expect([rounds(), empty(view.host)]).toEqual([[], ["Wake transcripts are off.", "No wake calls yet."]]);
    await type(count(), "50");
    await settle();
    expect([rounds().length, empty(view.host)]).toEqual([1, []]);
    await tab(view.host, "Dream transcript");
    expect([rounds(), empty(view.host), (count() as HTMLSelectElement | null)?.value]).toEqual([[[`${time(DAY)} · round 1 · opus · end_turn`, "hello"]], [], "25"]);
    await type(count(), "100");
    await settle();
    expect(empty(view.host)).toEqual(["Dream transcripts are off.", "No dream calls yet."]);
    expect(asked(before)).toEqual([
      ["transcript", { count: 25 }], ["transcript", { count: 10 }], ["transcript", { count: 50 }], ["transcript", { count: 25, source: "dreaming" }], ["transcript", { count: 100, source: "dreaming" }],
    ]);
  });

  test("wake events and errors are tables, with API key fallbacks only when there were some", async () => {
    const time = await formats();
    const error = (text: string) => ({ timestamp: DAY, error_type: "provider", message: text, context: "turn 4" });
    const fallback = (extra: Record<string, unknown> = {}) => ({ timestamp: DAY, provider: "anthropic", model: "opus", character: "ada", from_key: "main", kind: "rate_limit", reason: "429", ...extra });
    const answers: Record<string, unknown[]> = {
      heartbeat_log: [{ events: [{ timestamp: DAY, kind: "message_sent", detail: "said hi" }] }, { events: [] }],
      error_log: [
        { errors: { count: 1, recent: [error("boom")] }, key_fallbacks: { count: 2, recent: [fallback({ to_key: "spare" }), fallback()] } },
        { errors: { count: 0, recent: [] }, key_fallbacks: { count: 0, recent: [] } },
        { errors: { count: 0, recent: [] }, key_fallbacks: { count: 1, recent: [fallback()] } },
      ],
    };
    app.answer((request) => answers[String(request["name"])]?.shift());
    const view = await traces();
    await tab(view.host, "Wake events");
    const heads = () => [...view.host.querySelectorAll(".settings-section thead")].map((head) => head.textContent);
    expect([heads(), cells(view.host), empty(view.host)]).toEqual([["WhenEventDetail"], [[time(DAY), "message sent", "said hi"]], []]);
    const count = () => view.host.querySelector("select[aria-label='Entries to show']");
    await type(count(), "10");
    await settle();
    expect([cells(view.host), empty(view.host)]).toEqual([[], ["No wake events yet."]]);
    await tab(view.host, "Errors");
    expect([heads(), view.host.querySelector(".tool-label")?.textContent, empty(view.host)]).toEqual([["WhenTypeMessageContext", "WhenProviderModelFrom → toReason"], "API key fallbacks", []]);
    const tables = () => [...view.host.querySelectorAll(".settings-section .table-wrap")].map((wrap) => cells(wrap));
    expect(tables()).toEqual([
      [[time(DAY), "provider", "boom", ["turn 4", "mono"]]],
      [[time(DAY), "anthropic", ["opus", "mono"], "main → spare", "429"], [time(DAY), "anthropic", ["opus", "mono"], "main → none", "429"]],
    ]);
    await type(count(), "10");
    await settle();
    expect([tables(), view.host.querySelector(".tool-label"), empty(view.host)]).toEqual([[[]], null, ["No errors recorded."]]);
    await type(count(), "50");
    await settle();
    expect([tables().length, view.host.querySelector(".tool-label")?.textContent]).toEqual([2, "API key fallbacks"]);
  });

  test("subagent runs can be filtered by tool call and show their result, failure and messages", async () => {
    const time = await formats();
    const answers: unknown[] = [
      { character: "ada", entries: [
        trace({ result: "found **it**", messages: [message("s_1", "user", "look"), message("s_2", "assistant", "*found*")] }),
        trace({ subagent: "scout", error: "timed out", messages_expired: true }),
        trace({ messages_expired: false, messages: [message("s_3", "system", "noted")] }),
      ] },
      { character: "ada", entries: [] },
      { character: "ada", entries: [trace()] },
    ];
    app.answer((request) => request["name"] === "subagent_trace" ? answers.shift() : undefined);
    const view = await traces();
    const before = app.socket().sent.length;
    expect(view.host.querySelector("input[aria-label='Tool call IDs']")).toBeNull();
    await tab(view.host, "Subagents");
    const runs = () => [...view.host.querySelectorAll(".settings-section details.payload")].map((item) => ({
      summary: item.querySelector("summary")?.textContent,
      result: item.querySelector(".prose-readout strong")?.textContent ?? null,
      error: item.querySelector(".form-error")?.textContent ?? null,
      expired: item.querySelector(":scope > .setting-description")?.textContent ?? null,
      messages: [...item.querySelectorAll(".segment-message")].map((said) => [said.querySelector(".setting-label")?.textContent, said.textContent?.slice(said.querySelector(".setting-label")?.textContent?.length ?? 0)]),
    }));
    expect([runs(), empty(view.host)]).toEqual([[
      { summary: `${time(DAY)} · helper · haiku`, result: "it", error: null, expired: null, messages: [["user", "look"], ["assistant", "found"]] },
      { summary: `${time(DAY)} · scout · haiku · failed`, result: null, error: "timed out", expired: "The subagent’s messages have expired.", messages: [] },
      { summary: `${time(DAY)} · helper · haiku`, result: null, error: null, expired: null, messages: [["system", "noted"]] },
    ], []]);
    expect(view.host.querySelector(".prose-readout")?.className).toBe("readout prose-readout");
    const ids = view.host.querySelector("input[aria-label='Tool call IDs']");
    await type(ids, "toolu_1, toolu_2  toolu_3,");
    await settle();
    expect([runs(), empty(view.host)]).toEqual([[], ["No subagent runs recorded."]]);
    await type(ids, "   ");
    await settle();
    expect([runs().length, empty(view.host)]).toEqual([1, []]);
    expect(asked(before)).toEqual([["subagent_trace", { count: 25 }], ["subagent_trace", { count: 25, ids: ["toolu_1", "toolu_2", "toolu_3"] }], ["subagent_trace", { count: 25 }]]);
  });

  test("each trace says why it could not be read", async () => {
    app.answer((request) => { if (!["list_threads", "discover_operations", "list_characters"].includes(String(request["name"]))) throw new Error(`no ${String(request["name"])}`); return undefined; });
    const view = await traces();
    const alerts: unknown[] = [view.host.querySelector("[role=alert]")?.textContent];
    for (const name of ["Thread log", "Wake transcript", "Dream transcript", "Wake events", "Errors", "Subagents"]) {
      await tab(view.host, name);
      alerts.push(view.host.querySelector("[role=alert]")?.textContent);
    }
    expect(alerts).toEqual(["no call_log", "no log", "no transcript", "no transcript", "no heartbeat_log", "no error_log", "no subagent_trace"]);
  });
});
