import { describe, expect, test } from "bun:test";

import type { ConfigSchemaEntry } from "../src/protocol/ConfigSchemaEntry.ts";
import type { ThreadView } from "../src/protocol/ThreadView.ts";
import { moveInThreads, sortThreads, threadSections, threadsOnScreen } from "../src/browser/sidebar/order.ts";
import { assertSettingsCoverage, configAt, settingControl, settingText } from "../src/browser/settings_forms.ts";

function thread(id: string, overrides: Partial<ThreadView> = {}): ThreadView {
  return { id, created_at: "2026-11-01T00:00:00Z", compaction: true, home: false, current: false, ...overrides };
}

const ids = (threads: readonly ThreadView[]) => threads.map((item) => item.id);

describe("the sidebar's thread order", () => {
  const threads = [
    thread("old", { created_at: "2026-10-01T00:00:00Z" }),
    thread("busy", { created_at: "2026-09-01T00:00:00Z", last_active: "2026-11-09T00:00:00Z" }),
    thread("main", { home: true }),
    thread("placed2", { folder: "work", position: 2 }),
    thread("placed1", { folder: "work", position: 1 }),
    thread("unplaced", { folder: "work", last_active: "2026-11-05T00:00:00Z" }),
    thread("orphan", { folder: "gone", created_at: "2026-10-15T00:00:00Z" }),
    thread("pinned", { position: 0 }),
    thread("story", { folder: "fiction" }),
  ];
  const folders = [{ name: "work", by_activity: true }, { name: "fiction" }];

  test("home leads, then loose threads newest first with placed ones after, then each folder", () => {
    const sections = threadSections(threads, folders);
    expect(ids(sections.pinned)).toEqual(["main"]);
    expect(ids(sections.loose)).toEqual(["busy", "orphan", "old", "pinned"]);
    expect(sections.folders.map((folder) => [folder.name, folder.byActivity, ids(folder.threads)])).toEqual([
      ["work", true, ["unplaced", "placed1", "placed2"]],
      ["fiction", false, ["story"]],
    ]);
    expect(ids(sortThreads(threads, folders))).toEqual(["main", "busy", "orphan", "old", "pinned", "unplaced", "placed1", "placed2", "story"]);
    expect(ids(sortThreads(threads)), "with no folders every thread is loose").toEqual(["main", "busy", "unplaced", "story", "orphan", "old", "pinned", "placed1", "placed2"]);
  });

  test("a collapsed folder hides its threads except the one open", () => {
    expect(ids(threadsOnScreen(threads, folders, new Set(["work"]), "placed1"))).toEqual(["main", "busy", "orphan", "old", "pinned", "placed1", "story"]);
    expect(ids(threadsOnScreen(threads, folders, new Set(["work", "fiction"]), null))).toEqual(["main", "busy", "orphan", "old", "pinned"]);
  });

  test("moving a thread places it before another, or last, in its new section, renumbering only that section", () => {
    const moved = moveInThreads(threads, folders, "old", { folder: "work", before: "placed1" });
    const work = moved.filter((item) => item.folder === "work").sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    expect(work.map((item) => [item.id, item.position])).toEqual([["unplaced", 0], ["old", 1], ["placed1", 2], ["placed2", 3]]);
    expect(moved.find((item) => item.id === "story"), "other sections are untouched").toBe(threads.find((item) => item.id === "story"));

    const last = moveInThreads(threads, folders, "story", { folder: "work" });
    expect(last.find((item) => item.id === "story")).toMatchObject({ folder: "work", position: 3 });

    const loose = moveInThreads(threads, folders, "placed2", { folder: "" });
    const freed = loose.find((item) => item.id === "placed2");
    expect(freed?.folder).toBeUndefined();
    expect(freed?.position, "last among the loose threads").toBe(4);

    const within = moveInThreads(threads, folders, "placed2", { before: "unplaced" });
    const workPositions = Object.fromEntries(within.filter((item) => item.folder === "work").map((item) => [item.id, item.position]));
    expect(workPositions, "staying in its own folder").toEqual({ placed2: 0, unplaced: 1, placed1: 2 });

    const missingTarget = moveInThreads(threads, folders, "old", { folder: "work", before: "nonexistent" });
    expect(missingTarget.find((item) => item.id === "old")?.position).toBe(3);
    expect(moveInThreads(threads, folders, "nonexistent", { folder: "work" })).toEqual(threads);
    expect(moveInThreads(threads, folders, "old", { folder: "unknown folder" }).find((item) => item.id === "old")).toMatchObject({ folder: "unknown folder", position: 0 });
  });
});

function entry(key: string, kind: ConfigSchemaEntry["kind"], overrides: Partial<ConfigSchemaEntry> = {}): ConfigSchemaEntry {
  return { key, kind, type: kind, settable: true, optional: false, restart_required: false, secret: false, values: [], ...overrides };
}

describe("editing a setting", () => {
  test("each kind of setting gets a control of its kind, with the range its width allows", () => {
    expect(settingControl(entry("a", "boolean"))).toEqual({ kind: "boolean" });
    expect(settingControl(entry("a", "string"))).toEqual({ kind: "string" });
    expect(settingControl(entry("a", "duration"))).toEqual({ kind: "string" });
    expect(settingControl(entry("a", "integer", { width: "u32" }))).toEqual({ kind: "integer", minimum: 0, maximum: 4_294_967_295 });
    expect(settingControl(entry("a", "integer"))).toEqual({ kind: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
    expect(settingControl(entry("a", "float"))).toEqual({ kind: "number" });
    expect(settingControl(entry("a", "enum", { values: ["low", "high"] }))).toEqual({ kind: "string", choices: ["low", "high"] });
    expect(() => settingControl(entry("mode", "enum"))).toThrow("Missing setting choices: mode");
    expect(settingControl(entry("a", "list", { item_kind: "integer", width: "u32" }))).toEqual({ kind: "array", item: { kind: "integer", minimum: 0, maximum: 4_294_967_295 } });
    for (const item of [undefined, "list", "table", "map", "unknown"] as const) {
      expect(() => settingControl(entry("tags", "list", item === undefined ? {} : { item_kind: item })), String(item)).toThrow("Unsupported setting collection: tags");
    }
    expect(() => settingControl(entry("servers", "table"))).toThrow("Unsupported editable setting: servers (table)");
  });

  test("a value is written as the text the config file takes, after checking it fits", () => {
    expect(settingText(entry("a", "list"), ["x", 1])).toBe('["x",1]');
    expect(() => settingText(entry("a", "list"), "x")).toThrow("Choose a collection of values");
    expect(settingText(entry("a", "integer"), 5)).toBe("5");
    expect(settingText(entry("a", "float"), 0.5)).toBe("0.5");
    expect(() => settingText(entry("a", "float"), Number.NaN)).toThrow("Enter a finite number");
    expect(() => settingText(entry("a", "integer"), "5")).toThrow("Enter a finite number");
    expect(settingText(entry("a", "boolean"), true)).toBe("true");
    expect(settingText(entry("a", "string"), "x")).toBe("x");
    expect(() => settingText(entry("a", "string"), null)).toThrow("Enter a value before saving");
    expect(() => settingText(entry("a", "string"), { x: 1 })).toThrow("Enter a value before saving");
  });

  test("a setting's current value is found by its dotted key, quoted parts included", () => {
    const config = { chat: { model: "opus" }, providers: { "my.provider": { keys: ["a"] } }, list: [1] };
    expect(configAt(config, "chat.model")).toBe("opus");
    expect(configAt(config, 'providers."my.provider".keys')).toEqual(["a"]);
    expect(configAt(config, "chat.missing")).toBeNull();
    expect(configAt(config, "list.0")).toBeNull();
    expect(configAt(config, "chat..model")).toBeNull();
    expect(configAt(config, "chat model")).toBeNull();
    expect(configAt("not an object", "chat")).toBeNull();
    expect(configAt({ toString: 1 }, "toString")).toBe(1);
    expect(configAt({}, "toString")).toBeNull();
    expect(configAt({ chat: "text" }, "chat.length"), "a plain value has no settings inside it").toBeNull();
  });

  test("every setting is either editable with a known control or deliberately read-only", () => {
    const renderers = new Set(["boolean", "string", "integer", "number", "array"]);
    expect(() => { assertSettingsCoverage([entry("a", "boolean"), entry("b", "list", { item_kind: "string" }), entry("c", "table", { settable: false }), entry("d.<index>.e", "string", { settable: false })], renderers); }).not.toThrow();
    expect(() => { assertSettingsCoverage([entry("a", "list", { item_kind: "string" })], new Set(["array"])); }).toThrow("Missing settings renderer: string");
    expect(() => { assertSettingsCoverage([entry("a", "boolean")], new Set(["string"])); }).toThrow("Missing settings renderer: boolean");
    expect(() => { assertSettingsCoverage([entry("version", "string", { settable: false })], renderers); }).toThrow("Unaccounted read-only setting: version");
    expect(() => { assertSettingsCoverage([entry("d.<index>.e", "boolean", { settable: false }), entry("m", "map", { settable: false }), entry("l", "list", { settable: false })], new Set()); }).not.toThrow();
  });
});
