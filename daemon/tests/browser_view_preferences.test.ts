import { describe, expect, test } from "bun:test";

import { DisplayPreferences, PREFERENCE_STORAGE_KEY, VIEW_KEYS, budgetFocus, cycleView, defaultViews, readViews, viewValue } from "../src/browser/preferences.ts";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let failing: "read" | "write" | null = null;
  return {
    values,
    fail: (what: "read" | "write" | null) => { failing = what; },
    getItem: (key: string) => { if (failing === "read") throw new Error("blocked"); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (failing === "write") throw new Error("quota"); values.set(key, value); },
  };
}

const stored = (key: string) => `${PREFERENCE_STORAGE_KEY}.${key}`;

describe("the budget readout", () => {
  test("is a scope, a budget's name, or both, in any case and spacing", () => {
    expect(budgetFocus(" AUTO ")).toEqual({ name: null, scope: "auto" });
    expect(budgetFocus("cap")).toEqual({ name: null, scope: "cap" });
    expect(budgetFocus("Budget")).toEqual({ name: null, scope: "cap" });
    expect(budgetFocus("pace")).toEqual({ name: null, scope: "pace" });
    expect(budgetFocus("monthly")).toEqual({ name: "monthly", scope: "auto" });
    expect(budgetFocus(" monthly : PACE ")).toEqual({ name: "monthly", scope: "pace" });
    expect(budgetFocus("monthly:budget")).toEqual({ name: "monthly", scope: "cap" });
    for (const bad of ["monthly:weekly", "monthly:cap:again", ":cap", "  ", "  :pace"]) expect(() => budgetFocus(bad), bad).toThrow("Choose a budget and a valid budget scope");
  });
});

describe("display choices", () => {
  test("take only their own values, never toggle as a value, and a budget readout takes a budget too", () => {
    expect(viewValue("thinking", "off")).toBe(true);
    expect(viewValue("thinking", "toggle")).toBe(false);
    expect(viewValue("thinking", "maybe")).toBe(false);
    expect(viewValue("budget", "pace")).toBe(true);
    expect(viewValue("budget", "monthly:cap")).toBe(true);
    expect(viewValue("budget", "monthly:weekly")).toBe(false);
    expect(viewValue("usage", "monthly")).toBe(false);
  });

  test("start from their defaults, honour the two old switches, and refuse a broken saved value", () => {
    expect(defaultViews()).toEqual({ timestamps: "on", thinking: "on", tools: "on", subagent: "on", compaction: "on", images: "on", metadata: "off", usage: "off", budget: "auto" });
    expect(readViews(storage({ "shore.reasoning": "false", "shore.tools": "false" }))).toMatchObject({ thinking: "off", tools: "off" });
    expect(readViews(storage({ "shore.reasoning": "true", "shore.tools": "yes" }))).toMatchObject({ thinking: "on", tools: "on" });
    expect(readViews(storage({ "shore.reasoning": "false", [stored("thinking")]: "on", [stored("metadata")]: "on" }))).toMatchObject({ thinking: "on", metadata: "on" });
    expect(() => readViews(storage({ [stored("images")]: "sometimes" }))).toThrow("Saved display preference is invalid: images");
  });

  test("toggle through their own values in order, a budget readout through budgets when there are several", () => {
    expect(cycleView("thinking", "on")).toBe("off");
    expect(cycleView("thinking", "off")).toBe("on");
    expect(cycleView("thinking", "lost"), "from anything unknown, the first").toBe("on");
    expect(cycleView("budget", "auto", ["only"])).toBe("cap");
    expect(cycleView("budget", "pace", ["only"]), "one budget is not worth naming").toBe("auto");
    expect(cycleView("budget", "pace", ["monthly", "daily"])).toBe("monthly");
    expect(cycleView("budget", "daily", ["monthly", "daily"])).toBe("auto");
  });
});

describe("the display preferences of a tab", () => {
  test("change and save each choice, cycling on toggle, and refuse a value that does not fit", () => {
    const saved = storage();
    const preferences = new DisplayPreferences(saved);
    let heard = 0;
    const stop = preferences.subscribe(() => { heard += 1; });
    preferences.change("thinking", "toggle");
    expect(preferences.option("thinking")).toBe("off");
    expect(saved.values.get(stored("thinking"))).toBe("off");
    preferences.change("budget", "toggle", ["monthly", "daily"]);
    expect(preferences.option("budget")).toBe("cap");
    preferences.change("budget", "daily");
    expect(saved.values.get(stored("budget"))).toBe("daily");
    expect(() => { preferences.change("images", "sometimes"); }).toThrow("Invalid display preference: images");
    expect(heard).toBe(3);
    stop();
    preferences.change("thinking", "on");
    expect(heard).toBe(3);
    expect(preferences.getSnapshot().error).toBe("");
  });

  test("keep working on defaults when nothing saved can be read, and say so", () => {
    const unreadable = storage({ [stored("tools")]: "garbled" });
    const preferences = new DisplayPreferences(unreadable);
    expect(preferences.getSnapshot()).toEqual({ values: defaultViews(), error: "Could not read saved display preferences. Changes will stay in this tab until they can be saved." });
  });

  test("hold an unsaved choice until a save succeeds, and keep it over a reload meanwhile", () => {
    const saved = storage();
    const preferences = new DisplayPreferences(saved);
    saved.fail("write");
    preferences.change("metadata", "on");
    expect(preferences.getSnapshot()).toEqual({ values: { ...defaultViews(), metadata: "on" }, error: "Display preferences are not saved. Keep this tab open and retry saving." });
    saved.values.set(stored("timestamps"), "off");
    preferences.reload();
    expect(preferences.getSnapshot().values).toMatchObject({ metadata: "on", timestamps: "off" });
    expect(preferences.getSnapshot().error, "the unsaved choice is still unsaved").toBe("Display preferences are not saved. Keep this tab open and retry saving.");
    saved.fail(null);
    preferences.save();
    expect(saved.values.get(stored("metadata"))).toBe("on");
    expect(preferences.getSnapshot().error).toBe("");
    saved.values.set(stored("tools"), "off");
    preferences.reload();
    expect(preferences.getSnapshot()).toEqual({ values: { ...defaultViews(), metadata: "on", timestamps: "off", tools: "off" }, error: "" });
  });

  test("keep the current choices when a reload cannot read, and reset to defaults on request", () => {
    const saved = storage({ [stored("thinking")]: "off" });
    const preferences = new DisplayPreferences(saved);
    saved.values.set(stored("tools"), "garbled");
    let heard = 0;
    const stop = preferences.subscribe(() => { heard += 1; });
    preferences.reload();
    expect(preferences.getSnapshot()).toEqual({ values: { ...defaultViews(), thinking: "off" }, error: "Could not read changed display preferences. Current choices are retained in this tab." });
    expect(heard).toBe(1);
    saved.values.delete(stored("tools"));
    preferences.reset();
    expect(preferences.getSnapshot()).toEqual({ values: defaultViews(), error: "" });
    expect(VIEW_KEYS.map((key) => saved.values.get(stored(key)))).toEqual(VIEW_KEYS.map((key) => defaultViews()[key]));
    stop();
  });
});
