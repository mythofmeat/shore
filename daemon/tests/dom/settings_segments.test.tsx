import { describe, expect, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const summary = (index: number, extra: Record<string, unknown> = {}) => ({
  index, first_message_at: "2026-11-01T00:00:00Z", last_message_at: "2026-11-02T00:00:00Z", compacted_at: "2026-11-03T00:00:00Z", turn_count: 12, excluded: false,
  label: null, note: null, memory_before: null, memory_after: null, ...extra,
});
const settle = async () => { await acting(() => Bun.sleep(5)); };
const thread = (id: string, label?: string) => ({ id, created_at: "2026-11-01T00:00:00Z", compaction: true, home: id === "main", current: false, ...(label === undefined ? {} : { label }) });
const THREADS = [thread("main", "Home"), thread("story")];
const listing = (name: string, segments: unknown[]) => ({ character: "ada", thread: name, count: segments.length, segments });
const askedFor = (since: number) => app.sent(since).filter((request) => request["name"] === "segments").map((request) => request["args"]);
const segmentRows = (host: HTMLElement) => [...host.querySelectorAll(".segment")].map((segment) => [segment.querySelector(".setting-label")?.textContent, segment.querySelector(".setting-description")?.textContent]);
const page = async () => (await import("../../src/browser/settings/Segments.tsx")).SegmentsPage;

describe("the segments page", () => {
  test("needs a character and a connection, then lists the open thread's segments, newest first, with their labels, notes and dates", async () => {
    const SegmentsPage = await page();
    const { formatTime } = await import("../../src/browser/settings/shared.tsx");
    const snapshot = { ...app.state().workspace.getSnapshot(), threads: THREADS };
    const before = app.socket().sent.length;
    const none = await mount(<SegmentsPage state={{ ...snapshot, character: null }} />);
    await mount(<SegmentsPage state={{ ...snapshot, character: "ada", status: "reconnecting" }} />);
    await settle();
    expect(none.host.textContent).toContain("Choose a character");
    expect(askedFor(before)).toEqual([]);
    app.answer((request) => request["name"] === "segments" ? listing("story", [
      summary(1, { label: "The start", note: "keep", excluded: true }),
      summary(2, { last_message_at: "2026-11-05T00:00:00Z" }),
      summary(3, { last_message_at: null, compacted_at: "2026-11-04T00:00:00Z" }),
      summary(4, { last_message_at: "2026-11-05T00:00:00Z" }),
    ]) : undefined);
    const view = await mount(<SegmentsPage state={{ ...snapshot, character: "ada", thread: "story" }} />);
    await settle();
    expect(askedFor(before)).toEqual([{ thread: "story" }]);
    expect(view.host.querySelector("h2")?.textContent).toBe("Segments in ada");
    expect(view.host.querySelector(".settings-description")?.textContent).toBe("When a thread is compacted, its older turns become a segment.");
    const picker = view.host.querySelector<HTMLSelectElement>("select[aria-label=Thread]");
    expect([picker?.value, [...(picker?.options ?? [])].map((option) => [option.value, option.textContent])]).toEqual(["story", [["", "All threads"], ["main", "Home"], ["story", "story"]]]);
    expect(segmentRows(view.host).map(([label]) => label)).toEqual(["Segment 4", "Segment 2", "Segment 3", "The startexcluded"]);
    const first = view.host.querySelectorAll(".segment")[3];
    expect([first?.className, first?.querySelectorAll(".setting-description")[0]?.textContent, first?.querySelectorAll(".setting-description")[1]?.textContent]).toEqual([
      "segment excluded", `12 turns · ${formatTime("2026-11-01T00:00:00Z")} – ${formatTime("2026-11-02T00:00:00Z")} · compacted ${formatTime("2026-11-03T00:00:00Z")}`, "Note: keep",
    ]);
    expect(view.host.querySelectorAll(".segment")[0]?.querySelectorAll(".setting-description")).toHaveLength(1);
    const asked = app.socket().sent.length;
    await mount(<SegmentsPage state={{ ...snapshot, character: "ada", thread: null, threads: [] }} />);
    await settle();
    expect(askedFor(asked), "the main thread is the open one when none is named, listed or not").toEqual([{ thread: "main" }]);
  });

  test("all threads lists every thread's segments together, newest first, each saying which thread it is from, and acts on each in its own thread", async () => {
    const SegmentsPage = await page();
    const opened: unknown[][] = [];
    const openSegment = spyOn(app.state().workspace, "openSegment").mockImplementation(async (index) => { await Promise.resolve(); opened.push(["segment", index]); });
    const openThread = spyOn(app.state().workspace, "openThread").mockImplementation(async (name) => { await Promise.resolve(); opened.push(["thread", name]); });
    app.restores.push(() => { openSegment.mockRestore(); openThread.mockRestore(); });
    const changes: unknown[] = [];
    app.answer((request) => {
      if (request["name"] !== "segments") return undefined;
      const args = request["args"] as { action?: string; thread: string };
      if (args.action !== undefined) { changes.push(args); return { character: "ada", thread: args.thread, action: args.action, segment: summary(1) }; }
      return args.thread === "main" ? listing("main", [summary(1)]) : listing("story", [summary(1, { last_message_at: "2026-11-03T00:00:00Z" }), summary(2, { last_message_at: "2026-11-01T00:00:00Z" })]);
    });
    const view = await mount(<SegmentsPage state={{ ...app.state().workspace.getSnapshot(), character: "ada", thread: "story", threads: THREADS }} />);
    await settle();
    const before = app.socket().sent.length;
    await type(view.host.querySelector("select[aria-label=Thread]"), "");
    await settle();
    expect(askedFor(before)).toEqual([{ thread: "main" }, { thread: "story" }]);
    expect(segmentRows(view.host).map(([label, about]) => [label, about?.split(" · ")[0]])).toEqual([["Segment 1", "story"], ["Segment 1", "Home"], ["Segment 2", "story"]]);
    const home = view.host.querySelectorAll<HTMLElement>(".segment")[1];
    const own = view.host.querySelectorAll<HTMLElement>(".segment")[0];
    await click(button(home ?? view.host, "Exclude from chat logs"));
    await settle();
    expect(changes).toEqual([{ action: "exclude", index: 1, thread: "main" }]);
    await click(button(own ?? view.host, "Open in chat"));
    await settle();
    await click(button(view.host.querySelectorAll<HTMLElement>(".segment")[1] ?? view.host, "Open in chat"));
    await settle();
    expect(opened, "a segment in another thread opens that thread first").toEqual([["segment", 1], ["thread", "main"], ["segment", 1]]);
    await type(view.host.querySelector("select[aria-label=Thread]"), "story");
    await settle();
    expect(segmentRows(view.host).map(([, about]) => about?.startsWith("12 turns"))).toEqual([true, true]);
  });

  test("says when there are no segments yet, or why they could not be listed until another thread lists, and ignores an answer for a thread no longer shown", async () => {
    const SegmentsPage = await page();
    const snapshot = { ...app.state().workspace.getSnapshot(), character: "ada", thread: "story", threads: THREADS };
    app.answer((request) => request["name"] === "segments" ? listing("story", []) : undefined);
    const empty = await mount(<SegmentsPage state={snapshot} />);
    await settle();
    expect(empty.host.querySelector(".settings-empty")?.textContent).toBe("No segments yet. They appear when a thread is compacted.");
    app.answer((request) => request["name"] === "segments" ? { character: "ada", thread: "story", action: "exclude", segment: summary(1) } : undefined);
    const odd = await mount(<SegmentsPage state={snapshot} />);
    await settle();
    expect(odd.host.querySelector(".settings-empty")?.textContent, "an answer that is not a listing lists nothing").toBe("No segments yet. They appear when a thread is compacted.");
    app.answer((request) => {
      if (request["name"] !== "segments") return undefined;
      if ((request["args"] as { thread: string }).thread === "story") throw new Error("no index");
      return listing("main", [summary(7)]);
    });
    const failing = await mount(<SegmentsPage state={snapshot} />);
    await settle();
    expect(failing.host.querySelector("[role=alert]")?.textContent).toBe("no index");
    await type(failing.host.querySelector("select[aria-label=Thread]"), "main");
    await settle();
    expect([failing.host.querySelector("[role=alert]"), segmentRows(failing.host).map(([label]) => label)]).toEqual([null, ["Segment 7"]]);

    app.answer((request) => {
      if (request["name"] !== "segments") return undefined;
      return (request["args"] as { thread: string }).thread === "story" ? HOLD : listing("main", [summary(8)]);
    });
    const late = await mount(<SegmentsPage state={snapshot} />);
    await settle();
    const held = app.socket().sent.filter((request) => request["name"] === "segments").at(-1);
    await type(late.host.querySelector("select[aria-label=Thread]"), "main");
    await settle();
    app.socket().receive({ type: "command_output", rid: held?.["rid"], name: "segments", data: listing("story", [summary(9)]) });
    app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
    await settle();
    expect(segmentRows(late.host).map(([label]) => label)).toEqual(["Segment 8"]);
  });

  test("shows a segment's memory and messages once, by who said them", async () => {
    const SegmentsPage = await page();
    const snapshot = { ...app.state().workspace.getSnapshot(), character: "ada", thread: "story", threads: THREADS };
    let shows = 0;
    const message = (id: string, role: string, content: string) => ({ msg_id: id, role, content, images: [], content_blocks: [], timestamp: "2026-11-01T00:00:00Z" });
    app.answer((request) => {
      if (request["name"] !== "segments") return undefined;
      const args = request["args"] as { action?: string };
      if (args.action === "show") { shows += 1; return shows === 1 ? HOLD : { character: "ada", thread: "story", segment: summary(1), messages: [message("m_1", "user", "hi"), message("m_2", "assistant", "hello"), message("m_3", "system", "noted")] }; }
      return listing("story", [summary(1, { memory_after: "**remembered**" })]);
    });
    const view = await mount(<SegmentsPage state={snapshot} />);
    await settle();
    const toggle = button(view.host, "View");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    await settle();
    expect(view.host.querySelector(".segment-body [aria-label='Loading messages']")).not.toBeNull();
    const held = app.socket().sent.filter((request) => request["name"] === "segments").at(-1);
    expect(held?.["args"]).toEqual({ action: "show", index: 1, thread: "story" });
    app.socket().receive({ type: "command_output", rid: held?.["rid"], name: "segments", data: { character: "ada", thread: "story", segment: summary(1), messages: [message("m_1", "user", "hi"), message("m_2", "assistant", "hello"), message("m_3", "system", "noted")] } });
    app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
    await settle();
    expect([toggle.textContent, toggle.getAttribute("aria-expanded"), view.host.querySelector(".prose-readout strong")?.textContent]).toEqual(["Hide", "true", "remembered"]);
    expect([...view.host.querySelectorAll(".segment-message")].map((item) => [item.querySelector(".setting-label")?.textContent, item.textContent?.replace(item.querySelector(".setting-label")?.textContent ?? "", "")])).toEqual([["You", "hi"], ["ada", "hello"], ["System", "noted"]]);
    await click(toggle);
    expect(view.host.querySelector(".segment-body")).toBeNull();
    await click(toggle);
    await settle();
    expect(shows, "shown once").toBe(1);
  });

  test("excludes or includes a segment in the chat logs, labels and notes it, and opens it in the chat", async () => {
    const SegmentsPage = await page();
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const shown = spyOn(toasts, "show");
    const opened = spyOn(app.state().workspace, "openSegment").mockResolvedValue();
    app.restores.push(() => { shown.mockRestore(); opened.mockRestore(); });
    const changes: unknown[] = [];
    let lists = 0;
    let excluded = false;
    app.answer((request) => {
      if (request["name"] !== "segments") return undefined;
      const args = request["args"] as { action?: string };
      if (args.action === undefined) { lists += 1; return listing("story", [summary(4, { excluded, label: changes.some((change) => (change as { action: string }).action === "label") ? "Named" : null })]); }
      changes.push(args);
      if (args.action === "exclude") excluded = true;
      if (args.action === "include") excluded = false;
      return { character: "ada", thread: "story", action: args.action, segment: summary(4) };
    });
    const view = await mount(<SegmentsPage state={{ ...app.state().workspace.getSnapshot(), character: "ada", thread: "story", threads: THREADS }} />);
    await settle();
    await click(button(view.host, "Exclude from chat logs"));
    await settle();
    await click(button(view.host, "Include in chat logs"));
    await settle();
    await click(button(view.host, "Add label"));
    await type(view.host.querySelector("input[aria-label=Label]"), "Named");
    const form = view.host.querySelector("input[aria-label=Label]")?.closest("form");
    let submitted = true;
    await acting(() => { submitted = form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) ?? true; });
    await settle();
    expect([submitted, view.host.querySelector("input[aria-label=Label]")], "saving stays on the page and closes the editor").toEqual([false, null]);
    await click(button(view.host, "Edit label"));
    await type(view.host.querySelector("input[aria-label=Label]"), "Renamed");
    await click(button(view.host, "Cancel"));
    expect(view.host.querySelector("input[aria-label=Label]"), "cancelling closes the editor").toBeNull();
    await click(button(view.host, "Edit label"));
    expect(view.host.querySelector<HTMLInputElement>("input[aria-label=Label]")?.value, "and reopening starts from the saved label").toBe("Named");
    await click(button(view.host, "Cancel"));
    await click(button(view.host, "Add note"));
    await type(view.host.querySelector("input[aria-label=Note]"), "why");
    await acting(() => { view.host.querySelector("input[aria-label=Note]")?.closest("form")?.requestSubmit(); });
    await settle();
    expect(changes).toEqual([{ action: "exclude", index: 4, thread: "story" }, { action: "include", index: 4, thread: "story" }, { action: "label", index: 4, thread: "story", value: "Named" }, { action: "note", index: 4, thread: "story", value: "why" }]);
    expect(shown.mock.calls).toEqual([["Segment 4 excluded from chat logs"], ["Segment 4 included in chat logs"]]);
    expect(lists, "the list is read again after each change").toBe(5);
    location.hash = "#settings/segments";
    await click(button(view.host, "Open in chat"));
    await settle();
    expect([opened.mock.calls, location.hash]).toEqual([[[4]], ""]);
  });
});

describe("the diagnostics page", () => {
  const report = (extra: Record<string, unknown> = {}) => ({
    character: "ada", keepalive_halts: [], turn_count: 56, context_tokens: 7890, active_model: "opus", config_dir: "/cfg", data_dir: "/data", cache_dir: "/cache",
    pending_deferred_edit_count: 1, pending_deferred_edits: ["A.md"], tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4 }, autonomy: null, activity: null, history_index: null,
    sections: ["conversation", "autonomy", "unknown", "folders"], ...extra,
  });
  const requestsList = (requests: unknown[]) => ({ requests, max_records: 50, max_result_bytes: 1024 });
  const request = (id: string, phase: string, extra: Record<string, unknown> = {}) => ({ id, rid: `r_${id}`, operation: "message", label: `Request ${id}`, character: "ada", thread: "story", started_at: Date.UTC(2026, 10, 10), expires_at: 0, phase, result_omitted: false, ...extra });

  function serveHistory(lists: unknown[][], acknowledged: string[]) {
    const fetches = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      await Promise.resolve();
      if (url.endsWith("/list")) return Response.json(requestsList(lists.shift() ?? []));
      acknowledged.push(url);
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    app.restores.push(() => { fetches.mockRestore(); });
  }

  test("shows the character's status by section, and refreshes it", async () => {
    const { DiagnosticsPage } = await import("../../src/browser/settings/Diagnostics.tsx");
    serveHistory([[], []], []);
    let reads = 0;
    app.answer((asked) => { if (asked["name"] !== "status") return undefined; reads += 1; return report(); });
    const view = await mount(<DiagnosticsPage state={{ ...app.state().workspace.getSnapshot(), character: "ada" }} />);
    await settle();
    expect(view.host.querySelector(".settings-description")?.textContent).toBe("What the daemon knows about ada right now.");
    expect([...view.host.querySelectorAll(".stat")].map((stat) => [stat.querySelector(".stat-label")?.textContent, stat.querySelector(".stat-value")?.textContent])).toEqual([
      ["Turns", "56"], ["Context tokens", (7890).toLocaleString()], ["Model", "opus"],
    ]);
    const select = view.host.querySelector<HTMLSelectElement>("select[aria-label='Status section']");
    expect([...(select?.options ?? [])].map((option) => [option.value, option.textContent])).toEqual([["all", "All sections"], ["conversation", "Conversation"], ["folders", "Folders"], ["autonomy", "Autonomy"], ["edits", "Edits"]]);
    expect([...view.host.querySelectorAll(".status-section > .setting-label")].map((label) => label.textContent)).toEqual(["Conversation", "Folders", "Autonomy", "Edits"]);
    await type(select, "folders");
    expect([...view.host.querySelectorAll(".status-section .kv-row dt")].map((term) => term.textContent)).toEqual(["Config dir", "Data dir", "Cache dir"]);
    await type(select, "autonomy");
    expect(view.host.querySelector(".status-section > span")?.textContent, "a section of one field shows that field alone").toBe("—");
    await click(view.host.querySelector(".settings-section .settings-section-head button"));
    await settle();
    expect(reads).toBe(2);
  });

  test("shows a status without a model or context size, and asks for a character first", async () => {
    const { DiagnosticsPage } = await import("../../src/browser/settings/Diagnostics.tsx");
    serveHistory([[], []], []);
    app.answer((asked) => asked["name"] === "status" ? report({ active_model: null, context_tokens: undefined, sections: [] }) : undefined);
    const view = await mount(<DiagnosticsPage state={{ ...app.state().workspace.getSnapshot(), character: "ada" }} />);
    await settle();
    expect([...view.host.querySelectorAll(".stat-value")].slice(1).map((value) => value.textContent)).toEqual(["—", "—"]);
    const before = app.socket().sent.length;
    const none = await mount(<DiagnosticsPage state={{ ...app.state().workspace.getSnapshot(), character: null }} />);
    await settle();
    expect([none.host.textContent?.includes("Choose a character"), app.sent(before).some((asked) => asked["name"] === "status"), none.host.querySelector("h2")?.textContent]).toEqual([true, false, "Recent requests"]);
  });

  test("lists recent requests with what to do about each, settling the uncertain ones the list knows", async () => {
    const { DiagnosticsPage } = await import("../../src/browser/settings/Diagnostics.tsx");
    const acknowledged: string[] = [];
    serveHistory([
      [request("1", "running"), request("2", "uncertain", { character: null, thread: null, result_omitted: true }), request("3", "completed")],
      [request("1", "running")],
      [],
    ], acknowledged);
    app.answer((asked) => asked["name"] === "status" ? HOLD : undefined);
    const state = app.state();
    const selection = { character: "ada", thread: "story", messageRevision: 1, snapshotRevision: 1 };
    state.workspace["acknowledge"]("none");
    const uncertain = [{ kind: "uncertain" as const, rid: "r_2", request: { type: "message" as const, text: "x", stream: true, images: [] }, selection }];
    const snapshot = spyOn(state.workspace, "getSnapshot").mockReturnValue({ ...state.workspace.getSnapshot(), uncertain });
    const acknowledge = spyOn(state.workspace, "acknowledge");
    app.restores.push(() => { snapshot.mockRestore(); acknowledge.mockRestore(); });
    const view = await mount(<DiagnosticsPage state={{ ...state.workspace.getSnapshot(), character: "ada", status: "ready" }} />);
    await settle();
    expect(acknowledge.mock.calls, "an uncertain request the daemon still lists is settled").toEqual([["r_2"]]);
    const rows = [...view.host.querySelectorAll(".archive")];
    expect(rows.map((row) => [row.getAttribute("aria-label"), row.querySelector(".status-text")?.className, row.querySelector("button")?.textContent ?? null])).toEqual([
      ["Request 1 request", "status-text wait", null], ["Request 2 request", "status-text bad", "I checked it"], ["Request 3 request", "status-text ok", "Dismiss"],
    ]);
    expect(rows[1]?.querySelector(".setting-description")?.textContent).toContain("Daemon · ");
    expect(rows[1]?.querySelector(".setting-description")?.textContent).toContain(" · result too large to keep");
    expect(rows[0]?.querySelector(".setting-description")?.textContent?.startsWith("ada / story · ")).toBe(true);
    await click(button(view.host, "Dismiss"));
    await settle();
    expect(acknowledged).toEqual(["/api/requests/3/acknowledge"]);
    expect(acknowledge.mock.calls.at(-1)).toEqual(["r_3"]);
    expect(view.host.querySelectorAll(".archive")).toHaveLength(1);
    const history = [...view.host.querySelectorAll(".settings-section")].find((section) => section.querySelector("h2")?.textContent === "Recent requests");
    await click(button(history ?? view.host, "Refresh"));
    await settle();
    expect(history?.querySelector(".settings-empty")?.textContent).toBe("No recent requests.");
  });

  test("says when the request history cannot be read, and reads nothing while disconnected", async () => {
    const { DiagnosticsPage } = await import("../../src/browser/settings/Diagnostics.tsx");
    const fetches = spyOn(globalThis, "fetch").mockImplementation((async () => await Promise.resolve(new Response("", { status: 500 }))) as unknown as typeof fetch);
    app.restores.push(() => { fetches.mockRestore(); });
    app.answer((asked) => asked["name"] === "status" ? HOLD : undefined);
    const offline = await mount(<DiagnosticsPage state={{ ...app.state().workspace.getSnapshot(), character: null, status: "reconnecting" }} />);
    await settle();
    expect(fetches).not.toHaveBeenCalled();
    await offline.unmount();
    const view = await mount(<DiagnosticsPage state={{ ...app.state().workspace.getSnapshot(), character: null, status: "ready" }} />);
    await settle();
    expect(view.host.querySelector("[role=alert]")?.textContent).toBe("Couldn’t load request history. Try again after reconnecting.");
  });
});
