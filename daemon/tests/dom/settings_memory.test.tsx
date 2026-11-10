import { describe, expect, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const summary = (index: number, extra: Record<string, unknown> = {}) => ({
  index, first_message_at: "2026-11-01T00:00:00Z", last_message_at: "2026-11-02T00:00:00Z", compacted_at: "2026-11-03T00:00:00Z", message_count: 12, excluded: false,
  label: null, note: null, memory_before: null, memory_after: null, ...extra,
});
const settle = async () => { await acting(() => Bun.sleep(5)); };

describe("the memory page", () => {
  test("needs a character, then lists the thread's segments with their labels, notes and dates", async () => {
    const { MemoryPage } = await import("../../src/browser/settings/Memory.tsx");
    const { formatTime } = await import("../../src/browser/settings/shared.tsx");
    const snapshot = app.state().workspace.getSnapshot();
    const before = app.socket().sent.length;
    const none = await mount(<MemoryPage state={{ ...snapshot, character: null }} />);
    await settle();
    expect(none.host.textContent).toContain("Choose a character");
    expect(app.sent(before).some((request) => request["name"] === "segments")).toBe(false);
    app.answer((request) => request["name"] === "segments" ? { character: "ada", thread: "story", count: 2, segments: [summary(1, { label: "The start", note: "keep", excluded: true }), summary(2)] } : undefined);
    const view = await mount(<MemoryPage state={{ ...snapshot, character: "ada", thread: "story" }} />);
    await settle();
    expect(view.host.querySelector("h2")?.textContent).toBe("Segments in ada / story");
    const segments = [...view.host.querySelectorAll(".segment")];
    expect(segments.map((segment) => [segment.className, segment.querySelector(".setting-label")?.textContent])).toEqual([["segment excluded", "The startexcluded"], ["segment ", "Segment 2"]]);
    expect(segments[0]?.querySelectorAll(".setting-description")[0]?.textContent).toBe(`12 messages · ${formatTime("2026-11-01T00:00:00Z")} – ${formatTime("2026-11-02T00:00:00Z")} · compacted ${formatTime("2026-11-03T00:00:00Z")}`);
    expect([segments[0]?.querySelectorAll(".setting-description")[1]?.textContent, segments[1]?.querySelectorAll(".setting-description").length]).toEqual(["Note: keep", 1]);
    const main = await mount(<MemoryPage state={{ ...snapshot, character: "ada", thread: null }} />);
    await settle();
    expect(main.host.querySelector("h2")?.textContent).toBe("Segments in ada / main");
  });

  test("says when there are no segments yet, or why they could not be listed", async () => {
    const { MemoryPage } = await import("../../src/browser/settings/Memory.tsx");
    const snapshot = { ...app.state().workspace.getSnapshot(), character: "ada" };
    app.answer((request) => request["name"] === "segments" ? { character: "ada", thread: "story", count: 0, segments: [] } : undefined);
    const empty = await mount(<MemoryPage state={snapshot} />);
    await settle();
    expect(empty.host.querySelector(".settings-empty")?.textContent).toBe("No segments yet. They appear after the thread is compacted or cleared.");
    app.answer((request) => { if (request["name"] === "segments") throw new Error("no index"); return undefined; });
    const failing = await mount(<MemoryPage state={snapshot} />);
    await settle();
    expect(failing.host.querySelector("[role=alert]")?.textContent).toBe("no index");
    app.answer((request) => request["name"] === "segments" ? { character: "ada", thread: "story", action: "exclude", segment: summary(1) } : undefined);
    const odd = await mount(<MemoryPage state={snapshot} />);
    await settle();
    expect(odd.host.querySelector(".settings-empty [role=status]"), "an answer that is not a listing shows nothing yet").not.toBeNull();
  });

  test("shows a segment's memory and messages once, by who said them", async () => {
    const { MemoryPage } = await import("../../src/browser/settings/Memory.tsx");
    const snapshot = { ...app.state().workspace.getSnapshot(), character: "ada" };
    let shows = 0;
    const message = (id: string, role: string, content: string) => ({ msg_id: id, role, content, images: [], content_blocks: [], timestamp: "2026-11-01T00:00:00Z" });
    app.answer((request) => {
      if (request["name"] !== "segments") return undefined;
      const args = request["args"] as { action?: string };
      if (args.action === "show") { shows += 1; return shows === 1 ? HOLD : { character: "ada", thread: "story", segment: summary(1), messages: [message("m_1", "user", "hi"), message("m_2", "assistant", "hello"), message("m_3", "system", "noted")] }; }
      return { character: "ada", thread: "story", count: 1, segments: [summary(1, { memory_after: "**remembered**" })] };
    });
    const view = await mount(<MemoryPage state={snapshot} />);
    await settle();
    const toggle = button(view.host, "View");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    await settle();
    expect(view.host.querySelector(".segment-body [aria-label='Loading messages']")).not.toBeNull();
    const held = app.socket().sent.filter((request) => request["name"] === "segments").at(-1);
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

  test("excludes or includes a segment, labels and notes it, and opens it in the chat", async () => {
    const { MemoryPage } = await import("../../src/browser/settings/Memory.tsx");
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
      if (args.action === undefined) { lists += 1; return { character: "ada", thread: "story", count: 1, segments: [summary(4, { excluded, label: changes.some((change) => (change as { action: string }).action === "label") ? "Named" : null })] }; }
      changes.push(args);
      if (args.action === "exclude") excluded = true;
      if (args.action === "include") excluded = false;
      return { character: "ada", thread: "story", action: args.action, segment: summary(4) };
    });
    const view = await mount(<MemoryPage state={{ ...app.state().workspace.getSnapshot(), character: "ada" }} />);
    await settle();
    await click(button(view.host, "Exclude from memory"));
    await settle();
    await click(button(view.host, "Include in memory"));
    await settle();
    await click(button(view.host, "Add label"));
    await type(view.host.querySelector("input[aria-label=Label]"), "Named");
    await acting(() => { view.host.querySelector("input[aria-label=Label]")?.closest("form")?.requestSubmit(); });
    await settle();
    expect(view.host.querySelector("input[aria-label=Label]"), "saving closes the editor").toBeNull();
    await click(button(view.host, "Edit label"));
    expect(view.host.querySelector<HTMLInputElement>("input[aria-label=Label]")?.value).toBe("Named");
    await click(button(view.host, "Cancel"));
    await click(button(view.host, "Add note"));
    await type(view.host.querySelector("input[aria-label=Note]"), "why");
    await acting(() => { view.host.querySelector("input[aria-label=Note]")?.closest("form")?.requestSubmit(); });
    await settle();
    expect(changes).toEqual([{ action: "exclude", index: 4 }, { action: "include", index: 4 }, { action: "label", index: 4, value: "Named" }, { action: "note", index: 4, value: "why" }]);
    expect(shown.mock.calls).toEqual([["Segment 4 excluded from memory"], ["Segment 4 included in memory"]]);
    expect(lists, "the list is read again after each change").toBe(5);
    location.hash = "#settings/memory";
    await click(button(view.host, "Open in chat"));
    await settle();
    expect([opened.mock.calls, location.hash]).toEqual([[[4]], ""]);
  });
});

describe("the diagnostics page", () => {
  const report = (extra: Record<string, unknown> = {}) => ({
    character: "ada", keepalive_halts: [], message_count: 1234, turn_count: 56, context_tokens: 7890, active_model: "opus", config_dir: "/cfg", data_dir: "/data", cache_dir: "/cache",
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
      ["Messages", (1234).toLocaleString()], ["Turns", "56"], ["Context tokens", (7890).toLocaleString()], ["Model", "opus"],
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
    expect([...view.host.querySelectorAll(".stat-value")].slice(2).map((value) => value.textContent)).toEqual(["—", "—"]);
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
