import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { DisplayPreferences, PREFERENCE_STORAGE_KEY, VIEW_CONTROLS, VIEW_KEYS, budgetFocus, cycleView, defaultViews, readViews } from "../src/browser/preferences.ts";
import { VIEW_PREFERENCES } from "../src/browser/preferences.generated.ts";
import { focusedBudget, showPlanLimit, showUsage } from "../src/browser/budget_display.ts";
import { assertDisplayCoverage, switchCases } from "../scripts/browser_coverage.ts";
import capture from "./browser_captures/display_budgets.json" with { type: "json" };
import { recordedValue, recording } from "./support/rerecord.ts";

const CAPTURE = "tests/browser_captures/display_budgets.json";

function storage() {
  const data = new Map<string, string>();
  let fail = false;
  return { data, fail: (value: boolean) => { fail = value; }, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw new Error("Storage unavailable"); data.set(key, value); } };
}

test("all terminal display choices have controls and enum modes; omissions fail", async () => {
  const policy = await readFile(new URL("../src/browser/budget_display.ts", import.meta.url), "utf8");
  const modes = { usage: await switchCases(policy, "showUsage", "mode"), budget: await switchCases(policy, "budgetLevel", "scope") };
  expect(() => assertDisplayCoverage(VIEW_PREFERENCES, VIEW_CONTROLS, modes)).not.toThrow();
  for (const key of VIEW_KEYS) {
    expect(() => assertDisplayCoverage({ ...VIEW_PREFERENCES, [key]: [] }, VIEW_CONTROLS, modes)).toThrow(`Missing GUI display choices: ${key}`);
    expect(() => assertDisplayCoverage(VIEW_PREFERENCES, { ...VIEW_CONTROLS, [key]: undefined }, modes)).toThrow(`Missing GUI display control: ${key}`);
  }
  for (const [key, values] of Object.entries(modes)) for (const value of values) {
    const missing = await switchCases(policy.replace(`case "${value}":`, 'case "omitted":'), key === "usage" ? "showUsage" : "budgetLevel", key === "usage" ? "mode" : "scope");
    expect(() => assertDisplayCoverage(VIEW_PREFERENCES, VIEW_CONTROLS, { ...modes, [key]: missing })).toThrow(`Missing GUI display mode: ${key}:${value}`);
  }
});

for (const [index, budgetCase] of capture.cases.entries()) test(`browser budget conformance: ${budgetCase.label}`, () => {
  const selected = focusedBudget(budgetCase.budgets, budgetCase.focus);
  const shown = selected === undefined ? null : { name: selected.budget.name, scope: selected.scope, percent_used: selected.level.percent_used, visible: showUsage(budgetCase.mode, selected.budget) };
  recordedValue(CAPTURE, ["cases", index, "expected"], shown);
  if (!recording) expect<unknown>(budgetCase.expected).toEqual(shown);
});

for (const [index, plan] of capture.plan.entries()) test(`browser plan conformance: ${plan.label}`, () => {
  const visible = plan.windows.filter((limit) => showPlanLimit(plan.mode, limit)).map((limit) => limit.window);
  recordedValue(CAPTURE, ["plan", index, "visible"], visible);
  if (!recording) expect(plan.visible).toEqual(visible);
});

test("budget focus accepts the same scopes, aliases, names and invalid tokens as the terminal", () => {
  for (const [index, parser] of capture.parsers.entries()) {
    const focus = budgetFocus(parser.input);
    recordedValue(CAPTURE, ["parsers", index], { input: parser.input, ...focus });
    if (!recording) expect<unknown>(parser).toEqual({ input: parser.input, ...focus });
  }
  for (const input of capture.invalid) expect(() => budgetFocus(input)).toThrow();
});

test("preferences migrate existing quick controls and persist each display choice", () => {
  const saved = storage();
  saved.data.set("shore.reasoning", "false");
  saved.data.set("shore.tools", "false");
  const display = new DisplayPreferences(saved);
  expect(display.option("thinking")).toBe("off");
  expect(display.option("tools")).toBe("off");
  for (const key of VIEW_KEYS) {
    display.change(key, "toggle");
    expect(readViews(saved)[key]).toBe(display.option(key));
  }
  display.reset();
  expect(new DisplayPreferences(saved).getSnapshot().values).toEqual(defaultViews());
  expect(() => display.change("usage", "invalid")).toThrow();
});

test("cycling uses terminal ordering and includes budget names only with a choice of budgets", () => {
  for (const key of VIEW_KEYS) {
    const values = VIEW_PREFERENCES[key].filter((value) => value !== "toggle");
    let value: string = values[0] ?? "";
    for (let index = 1; index <= values.length; index++) { value = cycleView(key, value); expect<string | undefined>(value).toBe(values[index % values.length]); }
  }
  expect(cycleView("budget", "pace", ["Only"])).toBe("auto");
  expect(cycleView("budget", "pace", ["One", "Two"])).toBe("One");
  expect(cycleView("budget", "One", ["One", "Two"])).toBe("Two");
  expect(cycleView("budget", "Two", ["One", "Two"])).toBe("auto");
  expect(cycleView("budget", "Gone:pace", ["One", "Two"])).toBe("auto");
});

test("concurrent writes preserve other preferences and unsaved local choices survive reload notifications", () => {
  const saved = storage();
  const first = new DisplayPreferences(saved);
  const second = new DisplayPreferences(saved);
  first.change("thinking", "off");
  second.change("images", "off");
  first.reload();
  expect(first.option("images")).toBe("off");
  expect(second.option("thinking")).toBe("off");
  let notifications = 0;
  const unsubscribe = first.subscribe(() => { notifications++; });
  saved.fail(true);
  first.change("thinking", "on");
  expect(first.getSnapshot().error).toContain("not saved");
  saved.fail(false);
  second.change("tools", "off");
  first.reload();
  expect(first.option("thinking")).toBe("on");
  expect(first.option("tools")).toBe("off");
  first.save();
  expect(readViews(saved).thinking).toBe("on");
  expect(first.getSnapshot().error).toBe("");
  expect(notifications).toBe(3);
  unsubscribe();
  first.change("images", "on");
  expect(notifications).toBe(3);
});

test("corrupt or inaccessible storage reports errors and reset repairs persisted preferences", () => {
  const saved = storage();
  saved.data.set(`${PREFERENCE_STORAGE_KEY}.usage`, "toggle");
  const display = new DisplayPreferences(saved);
  expect(display.getSnapshot().error).toContain("Could not read");
  display.change("tools", "off");
  expect(display.option("tools")).toBe("off");
  expect(display.getSnapshot().error).not.toBe("");
  display.reset();
  expect(display.getSnapshot().error).toBe("");
  expect(readViews(saved)).toEqual(defaultViews());
  saved.data.set(`${PREFERENCE_STORAGE_KEY}.budget`, "Broken:auto");
  display.reload();
  expect(display.getSnapshot().error).toContain("Current choices are retained");
  saved.data.delete(`${PREFERENCE_STORAGE_KEY}.budget`);
  display.reload();
  expect(display.getSnapshot().error).toBe("");
  const denied = new DisplayPreferences({ getItem() { throw new Error("Denied"); }, setItem() { throw new Error("Denied"); } });
  denied.change("images", "off");
  expect(denied.option("images")).toBe("off");
  expect(denied.getSnapshot().error).toContain("not saved");
});

test("metadata accumulation is recorded for the terminal, preserving first-token timing and wide token counts", async () => {
  const { accumulateMetadata } = await import("../src/browser/metadata.ts");
  for (const [index, accumulation] of capture.metadata.entries()) {
    const accumulated = accumulateMetadata(accumulation.previous, accumulation.incoming);
    recordedValue(CAPTURE, ["metadata", index, "expected"], accumulated);
    if (!recording) expect<unknown>(accumulation.expected).toEqual(accumulated);
  }
});

test("stream metadata stays associated with its completed message through history and clears on selection", async () => {
  const { BrowserConnection } = await import("../src/browser/connection.ts");
  const { Workspace } = await import("../src/browser/workspace.ts");
  const { WEB_CONTRACT, WEB_PROTOCOL } = await import("../src/web/contract.ts");
  type Update = import("../src/browser/connection.ts").ConnectionUpdate;
  class Connection extends BrowserConnection {
    listeners = new Set<(update: Update) => void>();
    override subscribe(listener: (update: Update) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    emit(update: Update) { for (const listener of this.listeners) listener(update); }
  }
  const connection = new Connection({ origin: "http://localhost", contract: WEB_CONTRACT, protocol: WEB_PROTOCOL });
  const workspace = new Workspace(connection);
  const message = { msg_id: "answer", role: "assistant" as const, content: "Result", images: [], content_blocks: [], timestamp: "" };
  const history = { type: "history" as const, selected_character: "nova", selected_thread: "main", config: {}, revision: 1, messages: [message] };
  connection.emit({ kind: "frame", message: history });
  const metadata = { model: "fixture", tokens: { input: 4, output: 2, cache_read: 3, cache_write: 1 }, timing: { total_ms: 20, ttft_ms: 5 } };
  connection.emit({ kind: "frame", message: { type: "stream_end", rid: "run", msg_id: "answer", content: "Result", is_final: true, metadata } });
  expect(workspace.getSnapshot().metadata["answer"]).toEqual(metadata);
  connection.emit({ kind: "frame", message: { type: "stream_end", rid: "run", msg_id: "answer", subagent: "worker", content: "Nested", is_final: true, metadata: { ...metadata, model: "nested" } } });
  expect(workspace.getSnapshot().metadata["answer"]?.model).toBe("fixture");
  connection.emit({ kind: "frame", message: { ...history, revision: 2 } });
  expect(workspace.getSnapshot().metadata["answer"]).toEqual(metadata);
  connection.emit({ kind: "frame", message: { ...history, selected_thread: "other", revision: 3 } });
  expect(workspace.getSnapshot().metadata).toEqual({});
  connection.emit({ kind: "frame", message: { type: "stream_end", rid: "other", msg_id: "answer", content: "Result", is_final: true, metadata } });
  connection.emit({ kind: "status", status: "signed_out", detail: "" });
  expect(workspace.getSnapshot().metadata).toEqual({});
});
