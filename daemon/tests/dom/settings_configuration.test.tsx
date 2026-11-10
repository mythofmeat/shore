import { describe, expect, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };
const entry = (key: string, extra: Record<string, unknown> = {}) => ({ key, kind: "string", type: "String", settable: true, optional: true, restart_required: false, secret: false, values: [], ...extra });
const SOURCES = { chat_models: ["opus", "haiku"], image_models: [], tools: ["read"], subagents: [], characters: ["ada"], providers: ["anthropic", "local"] };
const SCHEMA = { sources: SOURCES, schema: [
  entry("model", { source: "chat_models" }),
  entry("chat.temperature", { kind: "float" }),
  entry("chat.max_tokens", { kind: "integer", restart_required: true }),
  entry("chat.stream", { kind: "boolean" }),
  entry("providers.<name>.key"),
  entry("hidden.thing", { settable: false }),
  entry("api.key", { secret: true }),
  entry("api.spare", { secret: true }),
  entry("api.token", { secret: true }),
  entry("lists.names", { kind: "list", item_kind: "string" }),
  entry("lists.empty", { kind: "list", item_kind: "string" }),
  entry("misc.object", { kind: "map" }),
  entry("misc.missing"),
  entry("misc.blank"),
  entry("misc.image", { source: "image_models" }),
  entry("misc.who", { source: "characters" }),
  entry("misc.provider", { key_source: "providers" }),
  entry("misc.level", { kind: "enum", values: ["low", "high"], source: "chat_models" }),
] };
const CONFIG = {
  model: "opus", chat: { temperature: 0.7, max_tokens: 1000, stream: true }, api: { key: "sk-1", spare: "" },
  lists: { names: ["a", { b: 1 }], empty: [] }, misc: { object: { a: 1 }, blank: "", level: "low" },
};
const DEFAULTS = { model: "haiku", chat: { temperature: 0.7, max_tokens: 4096, stream: false }, api: { key: "other" }, lists: { names: [] }, misc: { object: null } };
const ACCESS = {
  tools: [{ tool: "read", main: true, subagents: ["helper", "scout"] }, { tool: "write", main: false, subagents: [] }],
  subagents: [{ name: "helper", enabled: true, tools: ["read", "grep"], model: "haiku" }, { name: "idle", enabled: false, tools: [], model: null }],
  mcp: ["mcp__web__fetch", "mcp__x__y"], warnings: ["unknown tool zap"],
};
const setResult = (key: string, extra: Record<string, unknown> = {}) => ({ set: key, value: 1, previous: 0, file: "/cfg/config.toml", action: "set", restart_required: [], masked_by_preference: null, ...extra });
const check = (extra: Record<string, unknown> = {}) => ({ valid: true, warnings: [], info: [], config_dir: "/cfg", data_dir: "/data", cache_dir: "/cache", chat_models: 3, providers: 2, ...extra });
const reloaded = (extra: Record<string, unknown> = {}) => ({ applied: false, config_path: "/cfg/config.toml", character: "ada", changed_prompt_files: [], ...extra });

function serve(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  app.answer((request) => {
    const name = String(request["name"]);
    const args = request["args"] as Record<string, unknown>;
    const own = overrides[name];
    if (own !== undefined) return own(args);
    if (name === "config_schema") return SCHEMA;
    if (name === "config") return { config: CONFIG, defaults: DEFAULTS };
    if (name === "tools") return ACCESS;
    return undefined;
  });
}

async function toastSpy() {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const shown = spyOn(toasts, "show");
  app.restores.push(() => { shown.mockRestore(); });
  return () => shown.mock.calls.map(([text, tone]) => [text, tone ?? "info"]);
}

async function page(character: string | null = "ada") {
  const { ConfigurationPage } = await import("../../src/browser/settings/Configuration.tsx");
  const view = await mount(<ConfigurationPage state={{ ...app.state().workspace.getSnapshot(), character }} />);
  await settle();
  return view;
}

const section = (root: ParentNode, title: string) => [...root.querySelectorAll(".settings-section")].find((item) => item.querySelector("h2")?.textContent === title);
const groups = (root: ParentNode) => [...root.querySelectorAll(".config-group")].map((group) => [group.querySelector("summary")?.textContent, (group as HTMLDetailsElement).open]);
const rows = (root: ParentNode) => [...root.querySelectorAll(".config-row")].map((row) => [row.querySelector(".config-key")?.textContent, row.querySelector(".config-value")?.textContent]);
const row = (root: ParentNode, key: string) => {
  const found = [...root.querySelectorAll(".config-row")].find((item) => item.querySelector(".config-key .mono")?.textContent === key);
  if (found === undefined) throw new Error(`no setting ${key}`);
  return found;
};
const configReads = (since: number) => app.sent(since).filter((request) => request["name"] === "config" && JSON.stringify(request["args"]) === "{}").length;

describe("the configuration page", () => {
  test("groups the settable settings by their first part and shows each value, its tags and a default that differs", async () => {
    serve();
    const view = await page();
    expect(view.host.querySelector(":scope > .settings-description")?.textContent).toBe("The daemon’s configuration file, as it applies to ada. Tables such as providers and budgets are edited in the file itself.");
    expect(groups(view.host)).toEqual([["model1", false], ["chat3", false], ["api3", false], ["lists2", false], ["misc7", false]]);
    expect(view.host.querySelector(".config-group summary .mono")?.textContent).toBe("model");
    expect(rows(view.host)).toEqual([
      ["model", "opus · default haiku"],
      ["chat.temperature", "0.7"],
      ["chat.max_tokensrestart", "1000 · default 4096"],
      ["chat.stream", "true · default false"],
      ["api.keysecret", "Set (hidden)"],
      ["api.spare" + "secret", "Not set"],
      ["api.token" + "secret", "Not set"],
      ["lists.names", "a, {\"b\":1} · default None"],
      ["lists.empty", "None"],
      ["misc.object", "{\"a\":1}"],
      ["misc.missing", "Not set"],
      ["misc.blank", "Empty"],
      ["misc.image", "Not set"],
      ["misc.who", "Not set"],
      ["misc.provider", "Not set"],
      ["misc.level", "low"],
    ]);
    expect([...row(view.host, "chat.max_tokens").querySelectorAll(".tag")].map((tag) => [tag.className, tag.textContent])).toEqual([["tag muted-tag", "restart"]]);
    expect(row(view.host, "model").querySelector(".config-value .muted")?.textContent).toBe(" · default haiku");
    expect([view.host.querySelector(".config-search svg")?.getAttribute("width"), view.host.querySelector(".config-group summary svg")?.getAttribute("width"), view.host.querySelector(".config-group summary svg")?.getAttribute("class")]).toEqual(["16", "14", "config-chevron"]);
    const unnamed = await page(null);
    expect(unnamed.host.querySelector(":scope > .settings-description")?.textContent).toContain("as it applies to the current character.");
  });

  test("searches settings by key, opening the groups that match, and says when none do", async () => {
    serve();
    const view = await page();
    const search = view.host.querySelector<HTMLInputElement>("input[aria-label='Search settings']");
    expect([search?.type, search?.placeholder]).toEqual(["search", "Search settings"]);
    await type(search, " TEMP ");
    expect([groups(view.host), rows(view.host).map(([key]) => key)]).toEqual([[["chat1", true]], ["chat.temperature"]]);
    await type(search, "  zzz ");
    expect(view.host.querySelector(".settings-empty")?.textContent).toBe("No settings match “  zzz ”.");
    await type(search, "");
    expect(groups(view.host).every(([, open]) => open === false)).toBe(true);
    const { requestConfigSearch } = await import("../../src/browser/app/intents.ts");
    requestConfigSearch("api");
    const asked = await page();
    expect([asked.host.querySelector<HTMLInputElement>("input[aria-label='Search settings']")?.value, groups(asked.host)]).toEqual(["api", [["api3", true]]]);
    const later = await page();
    expect(later.host.querySelector<HTMLInputElement>("input[aria-label='Search settings']")?.value, "a search is asked for once").toBe("");
  });

  test("edits a setting in place and saves it as text, saying whether it needs a restart or is overridden", async () => {
    const toasts = await toastSpy();
    let saving: (args: Record<string, unknown>) => unknown = () => HOLD;
    serve({ config: (args) => args["key"] === undefined ? { config: CONFIG, defaults: DEFAULTS } : saving(args) });
    const view = await page();
    const tokens = row(view.host, "chat.max_tokens");
    await click(button(tokens, "Edit"));
    const input = tokens.querySelector<HTMLInputElement>("input[aria-label='chat.max_tokens']");
    expect([input?.value, tokens.querySelector("button.ghost"), button(tokens, "Save").disabled]).toEqual(["1000", null, false]);
    await click(button(tokens, "Cancel"));
    expect([tokens.querySelector(".config-editor"), button(tokens, "Edit").textContent]).toEqual([null, "Edit"]);
    await click(button(tokens, "Edit"));
    await type(tokens.querySelector("input[aria-label='chat.max_tokens']"), "2048");
    const before = app.socket().sent.length;
    await click(button(tokens, "Save"));
    expect(button(tokens, "Saving…").disabled).toBe(true);
    const held = app.sent(before).find((request) => request["name"] === "config");
    app.socket().receive({ type: "command_output", rid: held?.["rid"], name: "config", data: setResult("chat.max_tokens", { restart_required: ["chat.max_tokens"] }) });
    app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
    await settle();
    expect([tokens.querySelector(".config-editor"), configReads(before)]).toEqual([null, 1]);
    saving = (args) => args["key"] === "api.key" ? setResult("api.key", { masked_by_preference: "a browser preference" }) : args["key"] === "chat.temperature" ? { config: 1, defaults: 1 } : setResult(String(args["key"]));
    const secret = row(view.host, "api.key");
    await click(button(secret, "Edit"));
    const hidden = secret.querySelector<HTMLInputElement>("input[aria-label='api.key']");
    expect([hidden?.type, hidden?.value]).toEqual(["password", ""]);
    await type(hidden, "sk-2");
    await click(button(secret, "Save"));
    await settle();
    const stream = row(view.host, "chat.stream");
    await click(button(stream, "Edit"));
    await click(stream.querySelector("[role=switch]"));
    await click(button(stream, "Save"));
    await settle();
    const temperature = row(view.host, "chat.temperature");
    await click(button(temperature, "Edit"));
    await click(button(temperature, "Save"));
    await settle();
    const missing = row(view.host, "misc.missing");
    await click(button(missing, "Edit"));
    expect(missing.querySelector<HTMLInputElement>("input[aria-label='misc.missing']")?.value).toBe("");
    await click(button(missing, "Save"));
    await settle();
    expect(missing.querySelector(".config-editor"), "a value that cannot be saved keeps the editor open").not.toBeNull();
    expect(app.sent(before).filter((request) => request["name"] === "config" && request["args"] !== undefined && "key" in (request["args"] as object)).map((request) => request["args"])).toEqual([
      { key: "chat.max_tokens", value: "2048" }, { key: "api.key", value: "sk-2" }, { key: "chat.stream", value: "false" }, { key: "chat.temperature", value: "0.7" },
    ]);
    expect(toasts()).toEqual([
      ["Saved chat.max_tokens. Restart the daemon to apply it.", "info"], ["Saved, but a browser preference overrides it", "info"], ["Saved chat.stream", "info"], ["Saved chat.temperature", "info"],
      ["Enter a value before saving", "error"],
    ]);
  });

  test("offers the daemon's names for settings that take one, unless the setting has its own choices", async () => {
    serve();
    const view = await page();
    const choices = async (key: string) => {
      const found = row(view.host, key);
      await click(button(found, "Edit"));
      const field = found.querySelector(`[aria-label='${key}']`);
      return [field?.tagName, [...field?.querySelectorAll("option") ?? []].map((option) => option.getAttribute("value")), (field as HTMLSelectElement | null)?.value];
    };
    expect(await choices("model")).toEqual(["SELECT", ["", "opus", "haiku"], "opus"]);
    expect(await choices("misc.image")).toEqual(["INPUT", [], ""]);
    expect(await choices("misc.who")).toEqual(["SELECT", ["", "ada"], ""]);
    expect(await choices("misc.provider")).toEqual(["SELECT", ["", "anthropic", "local"], ""]);
    expect(await choices("misc.level")).toEqual(["SELECT", ["low", "high"], "low"]);
  });

  test("checks the configuration and reloads it from disk, applying it when asked", async () => {
    const toasts = await toastSpy();
    const checks = [check({ warnings: ["slow disk"], info: ["3 models"] }), check({ valid: false })];
    const reloads = [reloaded({ changed_prompt_files: ["SOUL.md", "TOOLS.md"], restart_required: ["port"] }), reloaded({ applied: true }), reloaded({ restart_required: [] })];
    serve({ config_check: () => checks.shift(), config_reload: () => reloads.shift() });
    const { Icon } = await import("../../src/browser/ui/icons.tsx");
    const icons = await mount(<><Icon name="check" size={16} /><Icon name="alert" size={16} /></>);
    const [tick, warn] = [...icons.host.querySelectorAll("svg")].map((svg) => svg.outerHTML);
    const view = await page();
    const maintenance = section(view.host, "Maintenance");
    await click(button(view.host, "Check configuration"));
    await settle();
    const box = () => maintenance?.querySelector(".notice-box");
    expect([box()?.className, box()?.querySelector(".setting-label svg")?.outerHTML === tick, box()?.querySelector(".setting-label")?.textContent]).toEqual(["notice-box ", true, " The configuration is valid."]);
    expect([...box()?.querySelectorAll(".setting-description") ?? []].map((line) => line.textContent)).toEqual(["Warning: slow disk", "Note: 3 models"]);
    expect([...box()?.querySelectorAll(".kv-row") ?? []].map((line) => [line.querySelector("dt")?.textContent, line.querySelector("dd")?.textContent, line.querySelector("dd")?.className])).toEqual([
      ["Config folder", "/cfg", "mono"], ["Data folder", "/data", "mono"], ["Cache folder", "/cache", "mono"], ["Chat models / providers", "3 / 2", ""],
    ]);
    await click(button(view.host, "Check configuration"));
    await settle();
    expect([box()?.className, box()?.querySelector(".setting-label svg")?.outerHTML === warn, box()?.querySelector(".setting-label")?.textContent, box()?.querySelectorAll(".setting-description").length]).toEqual(["notice-box bad", true, " The configuration has problems.", 0]);
    const before = app.socket().sent.length;
    await click(button(view.host, "Reload from disk…"));
    await settle();
    const notice = () => maintenance?.querySelectorAll(".notice-box")[1];
    expect([...notice()?.querySelectorAll("p") ?? []].map((line) => line.textContent)).toEqual([
      "Reloading would pick up the files below.", "/cfg/config.toml", "Changed prompt files: SOUL.md, TOOLS.md", "Needs a daemon restart: port",
    ]);
    await click(button(view.host, "Apply and refresh prompts"));
    await settle();
    expect([...notice()?.querySelectorAll("p") ?? []].map((line) => line.textContent)).toEqual(["Reloaded the configuration from disk.", "/cfg/config.toml", "No prompt files changed."]);
    expect([notice()?.querySelector("button"), configReads(before), toasts()]).toEqual([null, 1, [["Configuration reloaded", "info"]]]);
    await click(button(view.host, "Reload from disk…"));
    await settle();
    expect(notice()?.querySelectorAll("p").length).toBe(3);
    expect(app.sent(before).filter((request) => request["name"] === "config_reload").map((request) => request["args"])).toEqual([{}, { apply: true, refresh_prompts: true }, {}]);
  });

  test("maintenance buttons wait for the action in hand", async () => {
    serve({ config_check: () => HOLD, config_reload: () => reloaded() });
    const view = await page();
    await click(button(view.host, "Reload from disk…"));
    await settle();
    await click(button(view.host, "Check configuration"));
    expect(["Check configuration", "Reload from disk…", "Apply and refresh prompts"].map((name) => button(view.host, name).disabled)).toEqual([true, true, true]);
    const held = app.socket().sent.filter((request) => request["name"] === "config_check").at(-1);
    app.socket().receive({ type: "command_output", rid: held?.["rid"], name: "config_check", data: check() });
    app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
    await settle();
    expect(button(view.host, "Check configuration").disabled).toBe(false);
  });

  test("lists which tools the character and its subagents can use", async () => {
    serve();
    const view = await page();
    const access = section(view.host, "Tool access");
    expect(access?.querySelector(".settings-section-head .settings-description")?.textContent).toBe("Which tools the character and its subagents can use.");
    expect([...access?.querySelectorAll("tbody tr") ?? []].map((line) => [...line.querySelectorAll("td")].map((cell) => [cell.textContent, cell.className]))).toEqual([
      [["read", "mono"], ["Yes", ""], ["helper, scout", ""]], [["write", "mono"], ["No", ""], ["—", ""]],
    ]);
    expect([...access?.querySelectorAll(":scope > p, :scope > .form-error") ?? []].map((line) => [line.className, line.textContent])).toEqual([
      ["setting-description", "MCP tools: mcp__web__fetch, mcp__x__y"], ["setting-description", "Subagent helper: read, grep · haiku"], ["setting-description", "Subagent idle (disabled): no tools"], ["form-error", "unknown tool zap"],
    ]);
    serve({ tools: () => ({ ...ACCESS, mcp: [], subagents: [], warnings: [] }) });
    const plain = await page();
    expect(section(plain.host, "Tool access")?.querySelectorAll(":scope > p").length).toBe(0);
  });

  test("waits for the schema and the configuration, and says why either could not be read", async () => {
    serve({ config: () => setResult("x") });
    const waiting = await page();
    expect(section(waiting.host, "Settings")?.querySelector(".settings-empty [role=status]")).not.toBeNull();
    serve({ config_schema: () => { throw new Error("no schema"); } });
    const schemaless = await page();
    expect(section(schemaless.host, "Settings")?.querySelector("[role=alert]")?.textContent).toBe("no schema");
    serve({ config: () => { throw new Error("no config"); }, tools: () => { throw new Error("no tools"); } });
    const configless = await page();
    expect([section(configless.host, "Settings")?.querySelector("[role=alert]")?.textContent, section(configless.host, "Tool access")?.querySelector("[role=alert]")?.textContent]).toEqual(["no config", "no tools"]);
    serve({ tools: () => HOLD });
    const toolless = await page();
    expect([section(toolless.host, "Tool access")?.querySelector(".settings-empty [role=status]") !== null, section(toolless.host, "Tool access")?.querySelector("table")]).toEqual([true, null]);
  });
});
