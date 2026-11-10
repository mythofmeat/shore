import { describe, expect, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const DAY = "2026-11-10T00:00:00Z";
const settle = async () => { await acting(() => Bun.sleep(5)); };
const level = { status: "ok", action: "warn", effective_action: "warn", warning_thresholds: [], crossed_warn_at: [], over_limit: false };
const pace = (percent: number) => ({ ...level, period: "day", window_start: DAY, window_end: DAY, allowance: 1, base_allowance: 1, rollover: 0, debt_adjustment: 0, current_cost: 0.5, remaining: 0.5, percent_used: percent, periods_remaining: 3 });
const budget = (name: string, extra: Record<string, unknown> = {}) => ({
  ...level, name, period: "day", period_start: DAY, period_end: DAY, reset_at: DAY, timezone: "UTC", current_cost: 0.5, cost_limit: 2, percent_used: 0.25,
  compaction_allowed_over_budget: true, filters: { character: null, provider: null, api_key: null, model: null, call_type: null, usage_kind: [] }, ...extra,
});
const limit = (window: string, extra: Record<string, unknown> = {}) => ({ ...level, window, percent_used: 0.42, resets_at: DAY, limit_at: 0.9, ...extra });
const account = (name: string, extra: Record<string, unknown> = {}) => ({ name, in_use: false, state: "ok", detail: "fine", email: null, subscription_type: null, windows: [], ...extra });
const plans = (windows: unknown[], accounts: unknown[] = []) => ({ updated_at: DAY, subscription_type: "max", windows, accounts });
const attempts = (pending: number, unresolved: number) => ({ pending, unresolved, estimated_cost_at_risk: 0.25 });
const summary = (extra: Record<string, unknown> = {}) => ({
  mode: "summary", period: "day", timezone: "UTC", summary: [], cache_health: [], anomaly_count_7d: 0, anomaly_counts_7d: [], cache_coverage: [], cost_sources: [], rate_limits: [],
  nanogpt_subscription: null, claude_plan_limits: null, call_attempts: attempts(0, 0), budgets: [], ...extra,
});
const totals = { call_count: 1234, total_input: 1, total_output: 2, total_cache_read: 3, total_cache_write: 4, total_cost: 0.5 };

async function page() {
  const { UsagePage } = await import("../../src/browser/settings/Usage.tsx");
  const view = await mount(<UsagePage state={app.state().workspace.getSnapshot()} />);
  await settle();
  return view;
}

async function formats() {
  const { formatCost, formatTime } = await import("../../src/browser/settings/shared.tsx");
  return { cost: formatCost, time: formatTime };
}

const table = (root: ParentNode) => ({
  head: [...root.querySelectorAll("thead th")].map((cell) => [cell.textContent, cell.className]),
  rows: [...root.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => [cell.textContent, cell.className])),
  empty: root.querySelector(".table-wrap .settings-empty")?.textContent ?? null,
});
const bars = (root: ParentNode) => [...root.querySelectorAll(".budgets .budget")].map((item) => ({
  head: [...item.querySelectorAll(".budget-head > span")].map((part) => part.textContent),
  tracks: [...item.querySelectorAll("[role=progressbar]")].map((track) => [track.className, track.getAttribute("aria-label"), track.getAttribute("aria-valuemin"), track.getAttribute("aria-valuemax"), track.getAttribute("aria-valuenow"), track.querySelector("span")?.style.width, track.getAttribute("title")]),
  notes: [...item.querySelectorAll(".setting-description")].map((note) => note.textContent),
}));
const facts = (root: ParentNode) => [...root.querySelectorAll(".usage-facts .kv-row")].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);
const usageArgs = (since: number) => app.sent(since).filter((request) => request["name"] === "usage").map((request) => request["args"]);

describe("the usage page", () => {
  test("a summary lists usage by model with budgets, plan limits, accounts and the facts behind them", async () => {
    const format = await formats();
    app.answer((request) => request["name"] === "usage" ? summary({
      summary: [{ provider: "anthropic", model: "opus", ...totals }], period_since: DAY, timezone: "Europe/London", anomaly_count_7d: 3, call_attempts: attempts(0, 1),
      budgets: [budget("daily", { percent_used: 1.006, current_cost: 2.012, over_limit: true, effective_action: "block", status: "over_limit", pace: pace(0.5) }), budget("tiny", { percent_used: 0.004 })],
      claude_plan_limits: plans([limit("five_hour", { percent_used: 1.2, over_limit: true, action: "pause_background", status: "over_limit" }), limit("seven_day", { percent_used: 0.004, resets_at: null })], [
        account("work", { in_use: true, email: "a@b.c", subscription_type: "max", state: "limited", detail: "5-hour window full", login_command: "claude login",
          windows: [{ window: "five_hour", percent_used: 1.5, resets_at: DAY }, { window: "seven_day", percent_used: 0.004, resets_at: null }] }),
        account("home", { email: "home", state: "unknown", detail: "never checked", windows: [{ window: "seven_day", percent_used: 0.25, resets_at: null }] }),
      ]),
      cost_sources: [{ cost_source: "catalog", calls: 10, unpriced_calls: 0, total_cost: 1.5 }, { cost_source: "estimate", calls: 2, unpriced_calls: 1, total_cost: 0 }],
      cache_health: [{ character: "ada", state: "warm", streak: 1 }, { character: "bo", state: "cold", streak: 2 }],
      rate_limits: [{ host: "api.example", observed_at: DAY, requests_remaining: 40, requests_limit: 50, resets_at: DAY }, { host: "other", observed_at: DAY, requests_remaining: 5 }, { host: "quiet", observed_at: DAY }],
    }) : undefined);
    const view = await page();
    expect(view.host.querySelector(":scope > .settings-description")?.textContent).toBe("Token usage and costs recorded by the daemon’s ledger.");
    const number = "number";
    expect(table(view.host)).toEqual({
      head: [["Provider", ""], ["Model", ""], ["Calls", number], ["Input", number], ["Output", number], ["Cache read", number], ["Cache write", number], ["Cost", number]],
      rows: [[["anthropic", ""], ["opus", ""], [(1234).toLocaleString(), number], ["1", number], ["2", number], ["3", number], ["4", number], [format.cost(0.5), number]]],
      empty: null,
    });
    const resets = format.time(DAY);
    const track = (name: string, valueNow: string, width: string, kind = "ok", title: string | null = null) => [`budget-track ${kind}`, name, "0", "100", valueNow, width, title];
    expect(bars(view.host)).toEqual([
      { head: ["daily", `${format.cost(2.012)} of ${format.cost(2)}`], tracks: [track("daily budget", "100", "100%", "over_limit")], notes: [`101% used · day · resets ${resets} · over limit (block) · pace 50%`] },
      { head: ["tiny", `${format.cost(0.5)} of ${format.cost(2)}`], tracks: [track("tiny budget", "0", "0.4%")], notes: [`0% used · day · resets ${resets}`] },
      { head: ["Claude 5-hour limit", "120% of the plan"], tracks: [track("Claude 5-hour limit", "100", "100%", "over_limit")], notes: [`resets ${resets} · past its 90% limit, so it pauses background work`] },
      { head: ["Claude weekly limit", "0% of the plan"], tracks: [track("Claude weekly limit", "0", "0.4%")], notes: ["no reset reported"] },
      { head: ["work (in use)", "a@b.c · max"], tracks: [track("work Claude 5-hour limit", "100", "100%", "over_limit", `Claude 5-hour limit: 100%, resets ${resets}`), track("work Claude weekly limit", "0", "0.4%", "over_limit", "Claude weekly limit: 0%")], notes: ["at a limit: 5-hour window full", "Sign in with claude login"] },
      { head: ["home", ""], tracks: [track("home Claude weekly limit", "25", "25%", "ok", "Claude weekly limit: 25%")], notes: ["not checked: never checked"] },
    ]);
    expect(facts(view.host)).toEqual([
      ["Period", `day since ${resets} (Europe/London)`],
      ["Anomalies (7 days)", "3"],
      ["Unresolved calls", `0 pending, 1 unresolved, up to ${format.cost(0.25)} at risk`],
      ["Cost source: catalog", `10 calls, ${format.cost(1.5)}`],
      ["Cost source: estimate", `2 calls (1 unpriced), ${format.cost(0)}`],
      ["Prompt cache: ada", "warm"],
      ["Prompt cache: bo", "cold (2 in a row)"],
      ["Rate limit: api.example", `40/50 requests, resets ${resets}`],
      ["Rate limit: other", "5/? requests"],
      ["Rate limit: quiet", ""],
    ]);
  });

  test("a quiet summary says nothing was recorded and shows unresolved calls only when there are some", async () => {
    const answers = [summary({ call_attempts: attempts(0, 0) }), summary({ call_attempts: attempts(2, 2) }), summary({ call_attempts: attempts(1, 0), period: "week" })];
    app.answer((request) => request["name"] === "usage" ? answers.shift() : undefined);
    const view = await page();
    expect([table(view.host).empty, view.host.querySelector(".budgets"), facts(view.host).map(([name]) => name)]).toEqual(["No usage recorded for this period.", null, ["Period", "Anomalies (7 days)"]]);
    expect(facts(view.host)[0]).toEqual(["Period", "day (UTC)"]);
    await type(view.host.querySelector("select[aria-label=Period]"), "today");
    await settle();
    expect(facts(view.host)[2]?.[0]).toBe("Unresolved calls");
    await type(view.host.querySelector("select[aria-label=Period]"), "week");
    await settle();
    expect(facts(view.host).map(([name]) => name)).toEqual(["Period", "Anomalies (7 days)", "Unresolved calls"]);
  });

  test("each kind of report asks with its own arguments, as do the period and the filters", async () => {
    const before = app.socket().sent.length;
    app.answer((request) => request["name"] === "usage" ? HOLD : undefined);
    const view = await page();
    const checked = () => ["Summary", "Breakdown", "Budgets", "Anomalies"].map((name) => button(view.host, name).getAttribute("aria-checked"));
    expect([checked(), view.host.querySelector("select[aria-label='Group by']"), view.host.querySelector(".settings-empty [role=status]") !== null]).toEqual([["true", "false", "false", "false"], null, true]);
    await click(button(view.host, "Breakdown"));
    expect(checked()).toEqual(["false", "true", "false", "false"]);
    expect([...view.host.querySelectorAll("select[aria-label='Group by'] option")].map((option) => [option.getAttribute("value"), option.textContent])).toEqual([
      ["model", "By model"], ["provider", "By provider"], ["call_type", "By call type"], ["kind", "By kind"], ["api_key", "By api key"], ["cost_source", "By cost source"],
    ]);
    await type(view.host.querySelector("select[aria-label='Group by']"), "call_type");
    await click(button(view.host, "Budgets"));
    await click(button(view.host, "Anomalies"));
    await click(button(view.host, "Summary"));
    expect([...view.host.querySelectorAll("select[aria-label=Period] option")].map((option) => [option.getAttribute("value"), option.textContent])).toEqual([
      ["", "Current budget window"], ["today", "Today"], ["week", "This week"], ["month", "This month"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["all", "All time"],
    ]);
    await type(view.host.querySelector("select[aria-label=Period]"), "30d");
    const filter = (name: string) => [...view.host.querySelectorAll(".filter-grid label")].find((label) => label.querySelector("span")?.textContent === name)?.querySelector("input");
    expect([...view.host.querySelectorAll(".filter-grid label span")].map((label) => label.textContent)).toEqual(["Provider", "Model", "API key", "Call type", "Character"]);
    await type(filter("Provider"), "  anthropic ");
    await type(filter("Model"), "   ");
    await type(filter("API key"), "main");
    await type(filter("Call type"), "chat");
    await type(filter("Character"), "ada");
    await settle();
    expect(usageArgs(before)).toEqual([
      {}, { group_by: "model" }, { group_by: "call_type" }, { budget: true }, { anomalies: true }, {}, { last: "30d" },
      { last: "30d", provider: "anthropic" }, { last: "30d", provider: "anthropic", api_key: "main" }, { last: "30d", provider: "anthropic", api_key: "main", call_type: "chat" },
      { last: "30d", provider: "anthropic", api_key: "main", call_type: "chat", character: "ada" },
    ]);
  });

  test("breakdowns, anomalies, budgets and exports each show their own report", async () => {
    const format = await formats();
    const answers: unknown[] = [
      { mode: "summary_by", dimension: "call_type", period: "day", summary: [{ group: "chat", ...totals }] },
      { mode: "anomalies", anomalies: [{ ts: DAY, character: "ada", model: "opus", call_type: "chat", anomaly: null, cache_read_tokens: 1000, cache_write_tokens: 2 }, { ts: DAY, character: "bo", model: "haiku", call_type: "heartbeat", anomaly: "cache miss", cache_read_tokens: 0, cache_write_tokens: 5 }] },
      { mode: "budget", timezone: "UTC", budgets: [], call_attempts: attempts(0, 0) },
      { mode: "budget", timezone: "UTC", budgets: [], call_attempts: attempts(0, 0), claude_plan_limits: plans([limit("seven_day")]) },
      { mode: "budget", timezone: "UTC", budgets: [budget("daily")], call_attempts: attempts(0, 0) },
      { mode: "csv", data: "a,b\n1,2" },
      { mode: "tsv", data: "a\tb" },
    ];
    app.answer((request) => request["name"] === "usage" ? answers.shift() : undefined);
    const view = await page();
    expect(table(view.host)).toMatchObject({ head: [["Call type", ""], ["Calls", "number"], ["Input", "number"], ["Output", "number"], ["Cache read", "number"], ["Cache write", "number"], ["Cost", "number"]], rows: [[["chat", ""], [(1234).toLocaleString(), "number"], ["1", "number"], ["2", "number"], ["3", "number"], ["4", "number"], [format.cost(0.5), "number"]]] });
    const period = view.host.querySelector("select[aria-label=Period]");
    const next = async (value: string) => { await type(period, value); await settle(); };
    await next("today");
    expect(table(view.host)).toEqual({
      head: [["Time", ""], ["Character", ""], ["Model", ""], ["Call type", ""], ["Issue", ""], ["Cache read", "number"], ["Cache write", "number"]],
      rows: [
        [[format.time(DAY), ""], ["ada", ""], ["opus", ""], ["chat", ""], ["—", ""], [(1000).toLocaleString(), "number"], ["2", "number"]],
        [[format.time(DAY), ""], ["bo", ""], ["haiku", ""], ["heartbeat", ""], ["cache miss", ""], ["0", "number"], ["5", "number"]],
      ],
      empty: null,
    });
    await next("week");
    expect([view.host.querySelector(".settings-section .settings-empty")?.textContent, view.host.querySelector(".budgets")]).toEqual(["No budgets are configured. Add a [[budgets]] section to the daemon configuration.", null]);
    await next("month");
    expect([view.host.querySelector(".settings-section .settings-empty"), bars(view.host).map((bar) => bar.head[0])]).toEqual([null, ["Claude weekly limit"]]);
    await next("7d");
    expect([view.host.querySelector(".settings-section .settings-empty"), bars(view.host).map((bar) => bar.head[0])]).toEqual([null, ["daily"]]);
    await next("30d");
    expect(view.host.querySelector(".settings-section > .settings-description")?.textContent).toBe(`CSV export ready (${(7).toLocaleString()} characters).`);
    await next("all");
    expect(view.host.querySelector(".settings-section > .settings-description")?.textContent).toBe("TSV export ready (3 characters).");
  });

  test("exports the report as CSV or TSV without its view, and says when no export came back", async () => {
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const shown = spyOn(toasts, "show");
    const made = spyOn(URL, "createObjectURL").mockReturnValue("blob:usage");
    const revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const saved: [string, string][] = [];
    const clicks = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push([this.href, this.download]); });
    app.restores.push(() => { shown.mockRestore(); made.mockRestore(); revoked.mockRestore(); clicks.mockRestore(); });
    let exporting: (args: Record<string, unknown>) => unknown = () => HOLD;
    app.answer((request) => {
      if (request["name"] !== "usage") return undefined;
      const args = request["args"] as Record<string, unknown>;
      return args["export_csv"] === true || args["export_tsv"] === true ? exporting(args) : summary();
    });
    const view = await page();
    await click(button(view.host, "Breakdown"));
    await type(view.host.querySelector("select[aria-label=Period]"), "week");
    await settle();
    const before = app.socket().sent.length;
    await click(button(view.host, "Export CSV"));
    expect([button(view.host, "Export CSV").disabled, button(view.host, "Export TSV").disabled]).toEqual([true, true]);
    const held = app.sent(before).find((request) => request["name"] === "usage");
    app.socket().receive({ type: "command_output", rid: held?.["rid"], name: "usage", data: { mode: "csv", data: "a,b" } });
    app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
    await settle();
    expect([button(view.host, "Export CSV").disabled, button(view.host, "Export TSV").disabled]).toEqual([false, false]);
    exporting = (args) => args["export_tsv"] === true ? { mode: "tsv", data: "a\tb" } : summary();
    await click(button(view.host, "Export TSV"));
    await settle();
    await click(button(view.host, "Export CSV"));
    await settle();
    expect(usageArgs(before)).toEqual([
      { last: "week", group_by: null, budget: null, anomalies: null, export_csv: true },
      { last: "week", group_by: null, budget: null, anomalies: null, export_tsv: true },
      { last: "week", group_by: null, budget: null, anomalies: null, export_csv: true },
    ]);
    const blobs = await Promise.all(made.mock.calls.map(async ([blob]) => [(blob as Blob).type, await (blob as Blob).text()]));
    expect([blobs, saved]).toEqual([[["text/csv", "a,b"], ["text/tab-separated-values", "a\tb"]], [["blob:usage", "shore-usage.csv"], ["blob:usage", "shore-usage.tsv"]]]);
    expect(shown.mock.calls).toEqual([["The daemon didn’t return an export", "error"]]);
  });

  test("the chat's usage chip and the budget it follows are saved in this browser", async () => {
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const { display } = app.state();
    const kept = { ...display.getSnapshot().values };
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); display.change("usage", kept.usage); display.change("budget", kept.budget); });
    const answers = [summary({ budgets: [budget("daily"), budget("odd:name")] }), { mode: "summary_by", dimension: "model", period: "day", summary: [] }, { mode: "budget", timezone: "UTC", budgets: [budget("weekly")], call_attempts: attempts(0, 0) }];
    app.answer((request) => request["name"] === "usage" ? answers.shift() : undefined);
    const view = await page();
    const usage = view.host.querySelector<HTMLSelectElement>("select[aria-label='Usage display']");
    const chosen = view.host.querySelector<HTMLSelectElement>("select[aria-label=Budget]");
    const measure = view.host.querySelector<HTMLSelectElement>("select[aria-label='Budget measure']");
    const names = () => [...chosen?.querySelectorAll("option") ?? []].map((option) => [option.getAttribute("value"), option.textContent]);
    expect([...view.host.querySelectorAll(".setting-row .setting-text")].map((row) => [row.querySelector(".setting-label")?.textContent, row.querySelector(".setting-description")?.textContent])).toEqual([
      ["Usage display", "Show a budget chip in the top bar."], ["Budget focus", "Which budget the chip follows, and whether it tracks the cap or the pace."],
    ]);
    expect([...view.host.querySelectorAll(".settings-section-head")].map((head) => [head.querySelector("h2")?.textContent, head.querySelector(".settings-description")?.textContent]).at(-1)).toEqual(["In the chat", "Kept by the daemon, so every browser and device shows the same."]);
    expect([...usage?.querySelectorAll("option") ?? []].map((option) => [option.getAttribute("value"), option.textContent])).toEqual([["off", "Never"], ["warn", "Only near a limit"], ["always", "Always"]]);
    expect([...measure?.querySelectorAll("option") ?? []].map((option) => [option.getAttribute("value"), option.textContent])).toEqual([["auto", "Whichever is higher"], ["cap", "Spending cap"], ["pace", "Pace"]]);
    expect([usage?.value, chosen?.value, measure?.value, names()]).toEqual(["off", "", "auto", [["", "Most used"], ["daily", "daily"], ["odd:name", "odd:name"]]]);
    await type(usage, "warn");
    const steps: [HTMLSelectElement | null, string][] = [[chosen, "daily"], [measure, "cap"], [chosen, ""], [measure, "pace"], [chosen, "daily"], [measure, "auto"], [chosen, ""]];
    const seen: string[] = [];
    for (const [select, value] of steps) {
      await type(select, value);
      seen.push(display.getSnapshot().values.budget);
    }
    expect([display.getSnapshot().values.usage, usage?.value, seen]).toEqual(["warn", "warn", ["daily", "daily:cap", "cap", "pace", "daily:pace", "daily", "auto"]]);
    expect([chosen?.value, measure?.value]).toEqual(["", "auto"]);
    await type(chosen, "odd:name");
    expect([display.getSnapshot().values.budget, shown.mock.calls]).toEqual(["auto", [["Error: Invalid display preference: budget", "error"]]]);
    await click(button(view.host, "Breakdown"));
    await settle();
    expect(names()).toEqual([["", "Most used"]]);
    await click(button(view.host, "Budgets"));
    await settle();
    expect(names()).toEqual([["", "Most used"], ["weekly", "weekly"]]);
  });
});
