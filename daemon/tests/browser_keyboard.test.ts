import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { commandCatalogue } from "../src/commands/registry.ts";
import { requestCatalogue } from "../src/operations/requests.ts";
import { switchCases } from "../scripts/browser_coverage.ts";
import { VIEW_PREFERENCES } from "../src/browser/preferences.generated.ts";
import { KEYBOARD_STORAGE, LOCAL_SHORTCUTS, MAX_BINDINGS, KeyboardBindings, bindingId, bindingValue, defaultBindings, keyFromEvent, matchingBinding, normalizeKey, reservedKey, shortcutTargets, validateBinding, validateSavedConfig, type Binding } from "../src/browser/keyboard.ts";

const binding = (key = "alt+u", target = "local:usage"): Binding => ({ key, target, scope: "global", mode: "run", args: {} });
function storage() {
  const data = new Map<string, string>(); let failure = false;
  return { data, fail: (value: boolean) => { failure = value; }, get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null, getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failure) throw new Error("Quota exceeded"); data.set(key, value); }, removeItem: (key: string) => { if (failure) throw new Error("Quota exceeded"); data.delete(key); } };
}

test("key notation distinguishes modifiers, shifted keys and browser Command", () => {
  for (const [input, result] of [["CTRL+ALT+k", "ctrl+alt+k"], ["Command+Enter", "meta+enter"], ["T", "shift+t"], ["option+shift+a", "alt+shift+a"], ["up", "arrowup"], ["ctrl+plus", "ctrl+plus"], ["space", "space"], ["Ж", "Ж"], ["İ", "İ"], ["shift+?", "?"], ["ctrl+shift+plus", "ctrl+plus"]]) expect(normalizeKey(input ?? "")).toBe(result ?? "");
  for (const key of ["", "ctrl", "ctrl+ctrl+k", "hyper+k", "ctrl++", "f25"]) expect(() => normalizeKey(key)).toThrow();
  expect(keyFromEvent({ key: "T", ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBe("shift+t");
  expect(keyFromEvent({ key: "Unidentified", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBeUndefined();
  expect(keyFromEvent({ key: "+", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe("ctrl+plus");
  expect(normalizeKey("ctrl+-")).toBe("ctrl+minus");
  expect(keyFromEvent({ key: "-", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe("ctrl+minus");
});

test("reserved editing and browser keys cannot be rebound; global letters need a modifier", () => {
  for (const key of ["escape", "tab", "ctrl+c", "meta+v", "ctrl+shift+t", "meta+r", "ctrl+w"]) { expect(reservedKey(key)).toBe(true); expect(() => bindingValue(binding(key))).toThrow("reserved"); }
  expect(() => bindingValue(binding("j"))).toThrow("need Ctrl, Alt or Command");
  expect(bindingValue({ ...binding("j"), scope: "normal" }).key).toBe("j");
  expect(() => bindingValue({ ...binding(), args: [] })).toThrow();
  expect(() => bindingValue({ ...binding(), args: { text: "界".repeat(12000) } })).toThrow("32 KiB");
});

test("typing, dialogs and modifier-specific bindings keep their own behavior", () => {
  const normal = { ...binding("k"), scope: "normal" as const };
  const global = binding("alt+k"); const cancel = binding("alt+c", "request:cancel");
  expect(matchingBinding([normal], "k", false, false)).toBe(normal);
  expect(matchingBinding([normal], "k", true, false)).toBeUndefined();
  expect(matchingBinding([global], "alt+k", true, false)).toBe(global);
  expect(matchingBinding([global], "alt+k", false, true)).toBeUndefined();
  expect(matchingBinding([cancel], "alt+c", true, true)).toBe(cancel);
  expect(matchingBinding([global], "meta+k", false, false)).toBeUndefined();
  expect(matchingBinding([{ ...global, scope: "normal" }, global], "alt+k", false, false)).toBe(global);
});

test("current catalogue operations, requests, preferences and local targets are reachable and omission fails", async () => {
  const operations = commandCatalogue(); const requests = requestCatalogue();
  const targets = shortcutTargets(operations, requests);
  const required = [...operations.map((item) => `operation:${item.name}`), ...requests.map((item) => `request:${item.name}`), ...Object.keys(VIEW_PREFERENCES).map((key) => `view:${key}`), ...Object.keys(LOCAL_SHORTCUTS).map((key) => `local:${key}`)];
  const assertTargets = (values: { id: string }[]) => { for (const id of required) if (!values.some((item) => item.id === id)) throw new Error(`Missing shortcut target: ${id}`); };
  expect(() => assertTargets(targets)).not.toThrow();
  for (const target of targets) { expect(() => bindingValue(binding("alt+b", target.id))).not.toThrow(); }
  for (const target of targets) expect(() => assertTargets(targets.filter((item) => item.id !== target.id))).toThrow(`Missing shortcut target: ${target.id}`);
  const app = await readFile(new URL("../src/browser/app.tsx", import.meta.url), "utf8");
  const assertRoutes = (routes: Set<string>) => { for (const domain of ["operation", "request", "view", "local"]) if (!routes.has(domain)) throw new Error(`Missing shortcut route: ${domain}`); };
  const awaited = await switchCases(app, "runBinding", "kind");
  expect(() => assertRoutes(awaited)).not.toThrow();
  for (const domain of ["operation", "request", "view", "local"]) {
    const omitted = await switchCases(app.replace(`case "${domain}":`, 'case "omitted":'), "runBinding", "kind");
    expect(() => assertRoutes(omitted)).toThrow(`Missing shortcut route: ${domain}`);
  }
  for (const operation of operations) expect(() => validateBinding({ ...binding("alt+o", `operation:${operation.name}`), mode: "open" }, operations, requests)).not.toThrow();
  expect(() => validateBinding({ ...binding("alt+s", "operation:create_character"), args: {} }, operations, requests)).toThrow("Complete");
  expect(() => validateBinding({ ...binding("alt+s", "operation:create_character"), args: { name: "from-shortcut" } }, operations, requests)).not.toThrow();
  expect(() => validateBinding({ ...binding("alt+s", "request:message"), args: { text: "template", stream: true } }, operations, requests)).not.toThrow();
  expect(() => validateBinding(binding("alt+s", "request:message"), operations, requests)).toThrow();
  expect(() => validateBinding({ ...binding("alt+s", "view:usage"), args: { value: "broken" } }, operations, requests)).toThrow();
});

test("overrides, removals and defaults survive reload without overwriting another tab", () => {
  const saved = storage(); const first = new KeyboardBindings(saved); const second = new KeyboardBindings(saved);
  first.put(binding()); second.put(binding("alt+d", "local:display")); first.reload();
  expect(first.getSnapshot().bindings.some((item) => item.key === "alt+d")).toBe(true);
  expect(second.getSnapshot().bindings.some((item) => item.key === "alt+u")).toBe(true);
  const palette = first.getSnapshot().bindings.find((item) => item.key === "ctrl+k"); if (palette === undefined) throw new Error("Missing default");
  first.remove(palette);
  const loaded = new KeyboardBindings(saved);
  expect(loaded.getSnapshot().bindings.some((item) => item.key === "ctrl+k")).toBe(false);
  first.remove(binding()); expect(saved.data.has(KEYBOARD_STORAGE + bindingId(binding()))).toBe(false);
  first.reset(); expect(new KeyboardBindings(saved).getSnapshot().bindings).toEqual(defaultBindings());
});

test("saved config presets require a known nonsecret key, while empty forms remain usable", () => {
  const schema = [{ key: "notifications.topic", secret: true }, { key: "compaction.min_turns", secret: false }];
  const config = { ...binding("alt+b", "operation:config"), args: { key: "notifications.topic", value: "fixture-secret" } };
  expect(() => validateSavedConfig(config, schema)).toThrow("cannot be saved");
  expect(() => validateSavedConfig({ ...config, mode: "open" }, schema)).toThrow("cannot be saved");
  expect(() => validateSavedConfig({ ...config, args: { ...config.args, key: "unknown.setting" } }, schema)).toThrow("cannot be saved");
  expect(() => validateSavedConfig(config, undefined)).toThrow("Wait for");
  expect(() => validateSavedConfig({ ...config, args: { ...config.args, key: "compaction.min_turns" } }, schema)).not.toThrow();
  expect(() => validateSavedConfig({ ...config, args: { key: "notifications.topic" } }, undefined)).not.toThrow();
  expect(() => validateSavedConfig({ ...config, args: { key: "notifications.topic", value: null } }, undefined)).not.toThrow();
  expect(() => validateSavedConfig({ ...config, target: "operation:label" }, undefined)).not.toThrow();
});

test("failed edits and deletes retain local intent across storage events and retry", () => {
  const saved = storage(); const first = new KeyboardBindings(saved); const second = new KeyboardBindings(saved);
  saved.fail(true); first.put(binding()); expect(first.getSnapshot().error).toContain("not saved");
  saved.fail(false); second.put(binding("alt+d")); first.reload();
  expect(first.getSnapshot().bindings.some((item) => item.key === "alt+u")).toBe(true);
  expect(first.getSnapshot().bindings.some((item) => item.key === "alt+d")).toBe(true);
  first.save(); expect(first.getSnapshot().error).toBe("");
  saved.fail(true); first.remove(binding()); first.reload(); expect(first.getSnapshot().bindings.some((item) => item.key === "alt+u")).toBe(false);
  saved.fail(false); first.save(); expect(new KeyboardBindings(saved).getSnapshot().bindings.some((item) => item.key === "alt+u")).toBe(false);
});

test("corrupt storage reports errors and reset repairs records; active binding count is bounded", () => {
  const saved = storage(); saved.data.set(KEYBOARD_STORAGE + "broken", "not JSON");
  const first = new KeyboardBindings(saved); expect(first.getSnapshot().error).toContain("Could not read");
  first.reset(); expect(first.getSnapshot().error).toBe("");
  let sequence = 0;
  while (first.getSnapshot().bindings.length < MAX_BINDINGS) { sequence++; first.put({ ...binding(String.fromCodePoint(0x400 + sequence)), scope: "normal" }); }
  expect(() => first.put(binding("alt+f24"))).toThrow("128");
  expect(first.getSnapshot().bindings.length).toBe(MAX_BINDINGS);
});
