import { describe, expect, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };
const model = (qualified: string, extra: Record<string, unknown> = {}) => ({ name: qualified.slice(qualified.indexOf(":") + 1), qualified_name: qualified, sdk: "anthropic", model_id: qualified.slice(qualified.indexOf(":") + 1), source: "static", hidden: false, favorite: false, ...extra });
const LISTING = {
  models: { anthropic: [model("anthropic:opus"), model("anthropic:haiku")] }, active: "anthropic:opus",
  roles: [{ role: "chat", model: "anthropic:opus", source: "character" }, { role: "heartbeat", model: "anthropic:haiku", source: "heartbeat.model" }, { role: "compaction", model: null, source: "inherits chat" }, { role: "sub-agents", model: "anthropic:haiku", source: null }],
  include_hidden: false, favorites_only: false, favorite_count: 0, hidden_count: 0,
};
const info = (qualified: string, extra: Record<string, unknown> = {}) => ({
  name: qualified, qualified_name: qualified, category: "chat", provider_key: "anthropic", sdk: "anthropic", model_id: "claude-opus", api_key_env: "ANTHROPIC_API_KEY", base_url: null,
  max_context_tokens: 200000, max_output_tokens: 32000, temperature: 0.7, top_p: null, budget_tokens: 1024, gemini_generation: null, max_tool_iterations: 50, reasoning_effort: "high",
  cache_ttl: "1h", cache_keepalive: null, cache_keepalive_pings: null, replay_prior_thinking: null, zai_clear_thinking: null, supports_images: true, openrouter_provider: null, ...extra,
});
const setting = (key: string, kind: string, applicability: string, extra: Record<string, unknown> = {}) => ({ key, kind, applicability, suggestions: [], allow_custom: true, ...extra });
const detail = (extra: Record<string, unknown> = {}) => ({
  model: "anthropic:opus", provider: "anthropic", model_id: "claude-opus", effective_sampler: { temperature: 0.7, top_p: 0.9 }, saved_global: { top_p: 0.9 }, saved_character: { temperature: 0.7 },
  setting_schema: [setting("temperature", "number", "honored"), setting("top_p", "number", "ignored"), setting("stop", "string", "rejected"), setting("mode", "string", "always", { allow_custom: false }), setting("thinking", "json_object", "always")],
  scopes: { temperature: "character", top_p: "global" }, ...extra,
});
const changed = (key: string, extra: Record<string, unknown> = {}) => ({ changed: true, scope: "character", model: "anthropic:opus", provider: "anthropic", model_id: "claude-opus", key, value: 1, ...extra });
const ACCESS = { tools: [], subagents: [{ name: "helper", enabled: true, tools: [], model: "anthropic:sonnet" }, { name: "scout", enabled: true, tools: [], model: null }], mcp: [], warnings: [] };

function serve(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  app.answer((request) => {
    const name = String(request["name"]);
    const args = request["args"] as Record<string, unknown>;
    const own = overrides[name];
    if (own !== undefined) return own(args);
    if (name === "list_models") return LISTING;
    if (name === "tools") return ACCESS;
    if (name === "model_info") return info(typeof args["name"] === "string" ? args["name"] : "anthropic:opus");
    if (name === "model_settings") return detail();
    return undefined;
  });
}

async function toastSpy() {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const shown = spyOn(toasts, "show");
  app.restores.push(() => { shown.mockRestore(); });
  return () => shown.mock.calls.map(([text, tone]) => [text, tone ?? "info"]);
}

async function page(extra: Record<string, unknown> = {}) {
  const { ModelsPage } = await import("../../src/browser/settings/Models.tsx");
  const threads = [{ id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true, chat_model: "anthropic:haiku" }, { id: "side", created_at: "2026-11-01T00:00:00Z", compaction: true, home: false, current: false }];
  const view = await mount(<ModelsPage state={{ ...app.state().workspace.getSnapshot(), character: "ada", thread: "story", threads, ...extra }} />);
  await settle();
  return view;
}

const section = (root: ParentNode, title: string) => [...root.querySelectorAll(".settings-section")].find((item) => item.querySelector("h2")?.textContent === title);
const choices = (root: ParentNode | undefined) => [...root?.querySelectorAll(".setting-row") ?? []].map((item) => [item.querySelector(".setting-label")?.textContent, item.querySelector(".select-button")?.textContent, item.querySelector(".setting-description")?.textContent ?? null]);
const named = (since: number, name: string) => app.sent(since).filter((request) => request["name"] === name).map((request) => request["args"]);
const settingRow = (root: ParentNode, label: string) => {
  const found = [...root.querySelectorAll(".setting-row")].find((item) => item.querySelector(".setting-label")?.textContent === label);
  if (found === undefined) throw new Error(`no setting ${label}`);
  return found;
};

describe("the models page", () => {
  test("needs a character, then shows the model each part uses and where that choice comes from", async () => {
    serve();
    const none = await page({ character: null });
    expect(none.host.textContent).toBe("Choose a character in the sidebar first; these settings belong to a character.");
    const view = await page();
    expect(view.host.querySelector(":scope > .settings-description")?.textContent).toBe("Which models ada uses. Changes apply to the next response.");
    expect(choices(section(view.host, "Chat"))).toEqual([["ada’s default", "anthropic:opus", "Chosen for ada"], ["This thread", "anthropic:haiku", "Chosen for thread story"]]);
    expect(section(view.host, "Background tasks")?.querySelector(".settings-section-head .settings-description")?.textContent).toBe("Heartbeat check-ins, compaction and dreaming can use a different model or settings from chat.");
    expect(choices(section(view.host, "Background tasks"))).toEqual([["Heartbeat", "anthropic:haiku", "From the configuration (heartbeat.model)"], ["Compaction", "Not set", "Same as chat"], ["Dreaming", "Not set", null]]);
    expect(choices(section(view.host, "Subagents"))).toEqual([["Subagent helper", "anthropic:sonnet", null], ["Subagent scout", "anthropic:haiku", "inherits"]]);
    const plain = await page({ thread: "side" });
    expect(choices(section(plain.host, "Chat"))[1]).toEqual(["This thread", "Not set", "Uses ada’s default"]);
    serve({ tools: () => ({ ...ACCESS, subagents: [] }) });
    const threadless = await page({ thread: null });
    expect([choices(section(threadless.host, "Chat")).length, section(threadless.host, "Subagents")]).toEqual([1, undefined]);
  });

  test("model details follow the part chosen, or any model, and only a part has settings", async () => {
    serve({ model_info: (args) => args["subagent"] === "helper" ? info("anthropic:sonnet", { supports_images: false, base_url: "https://proxy.example", top_p: 0.9 }) : args["background_task"] === "dreaming" ? info("anthropic:haiku", { supports_images: null }) : info(typeof args["name"] === "string" ? args["name"] : "anthropic:opus") });
    const before = app.socket().sent.length;
    const view = await page();
    const details = section(view.host, "Model details");
    const facts = () => [details?.querySelector(".setting-label")?.textContent, ...[...details?.querySelectorAll(".kv-row") ?? []].map((item) => [item.querySelector("dt")?.textContent, item.querySelector("dd")?.textContent, item.querySelector("dd")?.className].join("|"))];
    expect(facts()).toEqual([
      "anthropic:opus", "Provider|anthropic|", "Model ID|claude-opus|mono", "SDK|anthropic|", `Context window|${(200000).toLocaleString()}|`, `Max output|${(32000).toLocaleString()}|`,
      "Temperature|0.7|", "Reasoning effort|high|", "Thinking budget|1024|", "Images|Supported|", "Prompt cache TTL|1h|", "Tool iterations|50|", "API key variable|ANTHROPIC_API_KEY|mono",
    ]);
    expect(details?.querySelector(".setting-label")?.className).toBe("setting-label mono");
    const select = view.host.querySelector<HTMLSelectElement>("select[aria-label='Show details for']");
    expect([...select?.querySelectorAll("option") ?? []].map((option) => [option.getAttribute("value"), option.textContent, option.parentElement?.tagName])).toEqual([
      ["character", "Chat", "SELECT"], ["background:heartbeat", "Heartbeat", "SELECT"], ["background:compaction", "Compaction", "SELECT"], ["background:dreaming", "Dreaming", "SELECT"],
      ["subagent:helper", "Subagent helper", "SELECT"], ["subagent:scout", "Subagent scout", "SELECT"], ["model:anthropic:haiku", "anthropic:haiku", "OPTGROUP"], ["model:anthropic:opus", "anthropic:opus", "OPTGROUP"],
    ]);
    expect(select?.querySelector("optgroup")?.getAttribute("label")).toBe("Any model");
    const values = [select?.value];
    await type(select, "subagent:helper");
    await settle();
    values.push(select?.value);
    expect(facts().filter((fact) => fact?.startsWith("Images") === true || fact?.startsWith("Base URL") === true || fact?.startsWith("Top P") === true)).toEqual(["Top P|0.9|", "Images|Not supported|", "Base URL|https://proxy.example|mono"]);
    await type(select, "background:dreaming");
    await settle();
    values.push(select?.value);
    expect(facts().some((fact) => fact?.startsWith("Images") === true)).toBe(false);
    await type(select, "model:anthropic:haiku");
    await settle();
    values.push(select?.value);
    expect([facts()[0], section(view.host, "Model settings"), view.host.querySelector("[aria-label='Save settings for']")]).toEqual(["anthropic:haiku", undefined, null]);
    await type(select, "character");
    await settle();
    values.push(select?.value);
    expect(values).toEqual(["character", "subagent:helper", "background:dreaming", "model:anthropic:haiku", "character"]);
    expect(named(before, "model_info"), "details are read again once the model list arrives").toEqual([{}, {}, { subagent: "helper" }, { background_task: "dreaming" }, { name: "anthropic:haiku" }, {}]);
    expect(named(before, "model_settings")).toEqual([{}, { subagent: "helper" }, { background_task: "dreaming" }, {}]);
  });

  test("says while model details load or why they could not be read", async () => {
    serve({ model_info: () => HOLD, model_settings: () => HOLD });
    const waiting = await page();
    expect([section(waiting.host, "Model details")?.querySelector("[aria-label='Loading model details']") !== null, section(waiting.host, "Model settings")?.querySelector("[aria-label='Loading model settings']") !== null]).toEqual([true, true]);
    serve({ model_info: () => { throw new Error("unknown model"); }, model_settings: () => { throw new Error("no settings"); } });
    const failing = await page();
    expect([section(failing.host, "Model details")?.querySelector("[role=alert]")?.textContent, section(failing.host, "Model details")?.querySelector("[role=status]"), section(failing.host, "Model settings")?.querySelector("[role=alert]")?.textContent, section(failing.host, "Model settings")?.querySelector("[role=status]")]).toEqual(["unknown model", null, "no settings", null]);
    serve({ model_settings: () => ({ overview: true, character: "ada", roles: [], inherited_count: 0 }) });
    const overview = await page();
    expect(section(overview.host, "Model settings")?.querySelector("[aria-label='Loading model settings']"), "an overview is not a model's settings").not.toBeNull();
  });

  test("model settings are saved for the character or everyone, reset, and say where a value is set", async () => {
    const toasts = await toastSpy();
    let saving: (args: Record<string, unknown>) => unknown = () => HOLD;
    let settings = detail({ applies_to: "ada in story" });
    serve({ set_model_setting: (args) => saving(args), model_settings: (args) => args["key"] === undefined ? settings : detail({ saved_global: { temperature: 0.8 } }) });
    const view = await page();
    const panel = section(view.host, "Settings for opus");
    expect(panel?.querySelector(".settings-section-head .settings-description")?.textContent).toBe("Sampler and provider options. Empty fields use the model’s configured value.");
    const scope = () => [...view.host.querySelectorAll("[aria-label='Save settings for'] [role=radio]")].map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]);
    expect(scope()).toEqual([["ada", "true"], ["All characters", "false"]]);
    const labels = () => [...panel?.querySelectorAll(".rows > .setting-row") ?? []].map((item) => [item.querySelector(".setting-label")?.textContent, item.querySelector(".setting-description")?.textContent, [...item.querySelectorAll(".setting-control > button")].map((action) => action.textContent)]);
    expect(labels()).toEqual([["Temperature", "Current value: 0.7", ["Save", "Reset", ""]], ["Top p", "This provider ignores this setting.", ["Save", ""]], ["Thinking", "Current value: —", ["Save", ""]]]);
    const temperature = settingRow(view.host, "Temperature");
    const field = temperature.querySelector<HTMLInputElement>("input[aria-label=Temperature]");
    expect([field?.value, button(temperature, "Save").disabled, button(temperature, "Where is Temperature set?").tagName]).toEqual(["0.7", true, "BUTTON"]);
    await type(field, "0.5");
    expect(button(temperature, "Save").disabled).toBe(false);
    const before = app.socket().sent.length;
    await click(button(temperature, "Save"));
    expect([button(temperature, "Save").disabled, button(temperature, "Reset").disabled]).toEqual([true, true]);
    settings = detail({ applies_to: "ada in story", saved_character: { temperature: 0.55 } });
    const held = app.sent(before).find((request) => request["name"] === "set_model_setting");
    app.socket().receive({ type: "command_output", rid: held?.["rid"], name: "set_model_setting", data: changed("temperature") });
    app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
    await settle();
    expect([button(temperature, "Reset").disabled, named(before, "model_settings")]).toEqual([false, [{}]]);
    expect(button(temperature, "Save").disabled, "the field takes the value the daemon kept").toBe(true);
    settings = detail({ applies_to: "ada in story" });
    saving = (args) => args["value"] === null ? changed("temperature", { warning: "temperature is ignored by this model" }) : changed(String(args["key"]));
    await click(button(temperature, "Reset"));
    await settle();
    saving = () => { throw new Error("read-only config"); };
    await type(settingRow(view.host, "Temperature").querySelector("input[aria-label=Temperature]"), "0.6");
    await click(button(settingRow(view.host, "Temperature"), "Save"));
    await settle();
    expect(named(before, "set_model_setting")).toEqual([
      { key: "temperature", scope: "character", value: 0.5, name: "anthropic:opus" }, { key: "temperature", scope: "character", value: null, name: "anthropic:opus" }, { key: "temperature", scope: "character", value: 0.6, name: "anthropic:opus" },
    ]);
    expect(toasts()).toEqual([["Temperature saved", "info"], ["temperature is ignored by this model", "error"], ["read-only config", "error"]]);
    await click(button(settingRow(view.host, "Temperature"), "Where is Temperature set?"));
    await settle();
    expect(settingRow(view.host, "Temperature").querySelector(".setting-description")?.textContent).toBe("Set for this character: 0.7; set for all characters: 0.8; in effect: 0.7; from character");
    await click(button(settingRow(view.host, "Top p"), "Where is Top p set?"));
    await settle();
    expect(settingRow(view.host, "Top p").querySelector(".setting-description")?.textContent).toBe("Not set for ada in story; not set for all characters; in effect: 0.9; from global");
    expect(named(before, "model_settings").slice(-2)).toEqual([{ key: "temperature", name: "anthropic:opus" }, { key: "top_p", name: "anthropic:opus" }]);
    settings = detail({ saved_character: null, saved_global: null, scopes: {} });
    serve({ model_settings: (args) => args["key"] === undefined ? settings : detail({ saved_character: null, saved_global: null, scopes: { thinking: null } }) });
    const bare = await page();
    await click(button(settingRow(bare.host, "Thinking"), "Where is Thinking set?"));
    await settle();
    expect(settingRow(bare.host, "Thinking").querySelector(".setting-description")?.textContent).toBe("Not set for this character; not set for all characters; in effect: —");
    serve({ model_settings: (args) => args["key"] === undefined ? settings : { overview: true, character: "ada", roles: [], inherited_count: 0 } });
    const odd = await page();
    await click(button(settingRow(odd.host, "Temperature"), "Where is Temperature set?"));
    await settle();
    expect([settingRow(odd.host, "Temperature").querySelector(".setting-description")?.textContent, toasts().length], "an overview leaves the note alone").toEqual(["Current value: 0.7", 3]);
  });

  test("settings for everyone show the shared values, and a part's settings go to that part", async () => {
    serve({ set_model_setting: (args) => changed(String(args["key"])) });
    const view = await page();
    await click(button(view.host, "All characters"));
    const panel = () => section(view.host, "Settings for opus");
    expect([...view.host.querySelectorAll("[aria-label='Save settings for'] [role=radio]")].map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    const shown = () => [...panel()?.querySelectorAll(".rows > .setting-row") ?? []].map((item) => [item.querySelector<HTMLInputElement>("input, textarea")?.value, [...item.querySelectorAll(".setting-control > button")].map((action) => action.textContent).join(",")]);
    expect(shown()).toEqual([["", "Save,"], ["0.9", "Save,Reset,"], ["", "Save,"]]);
    const before = app.socket().sent.length;
    await type(settingRow(view.host, "Thinking").querySelector("textarea"), "{\"type\":\"enabled\"}");
    await click(button(settingRow(view.host, "Thinking"), "Save"));
    await settle();
    await click(button(view.host, "ada"));
    await type(view.host.querySelector("select[aria-label='Show details for']"), "background:compaction");
    await settle();
    await type(settingRow(view.host, "Temperature").querySelector("input"), "0.2");
    await click(button(settingRow(view.host, "Temperature"), "Save"));
    await settle();
    await click(button(settingRow(view.host, "Temperature"), "Where is Temperature set?"));
    await settle();
    expect(named(before, "set_model_setting")).toEqual([
      { key: "thinking", scope: "global", value: { type: "enabled" }, name: "anthropic:opus" }, { key: "temperature", scope: "character", value: 0.2, name: "anthropic:opus", background_task: "compaction" },
    ]);
    expect(named(before, "model_settings").at(-1)).toEqual({ key: "temperature", name: "anthropic:opus", background_task: "compaction" });
  });

  test("a part's model is changed in the picker, which then notes the chat's new model", async () => {
    const toasts = await toastSpy();
    let listing = LISTING;
    serve({ list_models: () => listing, switch_model: () => ({ target: "current", active: "anthropic:haiku" }) });
    const view = await page();
    await click(choices(section(view.host, "Chat")).length > 0 ? section(view.host, "Chat")?.querySelector(".select-button") : null);
    const dialog = () => view.host.querySelector("dialog");
    expect([dialog()?.querySelector("h2")?.textContent, dialog()?.querySelector("[role=radiogroup]"), dialog()?.querySelector(".form-text")?.textContent]).toEqual(["Model for ada’s default", null, "Currently using anthropic:opus."]);
    listing = { ...LISTING, active: "anthropic:haiku" };
    const before = app.socket().sent.length;
    await click([...dialog()?.querySelectorAll("[role=option]") ?? []].find((option) => option.textContent?.startsWith("anthropic:haiku")));
    await settle();
    expect([dialog(), app.state().workspace.getSnapshot().config]).toMatchObject([null, { active_model: "anthropic:haiku" }]);
    expect(named(before, "switch_model")).toEqual([{ name: "anthropic:haiku", include_hidden: false }]);
    expect(named(before, "model_info").length, "the details follow the new listing").toBe(1);
    await click(section(view.host, "Background tasks")?.querySelector(".select-button"));
    expect([dialog()?.querySelector("h2")?.textContent, dialog()?.querySelector(".form-text")?.textContent]).toEqual(["Model for heartbeat", "Currently using anthropic:haiku."]);
    await click(button(dialog() ?? view.host, "Close"));
    expect(dialog()).toBeNull();
    await click(section(view.host, "Background tasks")?.querySelectorAll(".select-button")[1]);
    expect(dialog()?.querySelector(".form-text")?.textContent).toBe("Currently using the configured default.");
    await click(button(dialog() ?? view.host, "Close"));
    expect(toasts()).toEqual([["ada’s default now uses haiku", "info"]]);
  });
});
