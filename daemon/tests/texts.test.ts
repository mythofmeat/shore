import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../src/config/loader.ts";
import { configSchema } from "../src/config/schema.ts";
import { listTexts } from "../src/texts/listing.ts";
import { parameterText, shippedText, TEXT_SPECS, TEXTS, toolText } from "../src/texts/registry.ts";
import { renderTemplate } from "../src/texts/template.ts";
import { Texts } from "../src/texts/texts.ts";
import { ALL_TOOLS, renderedTools } from "../src/tools/registry.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";
import { markTextsSeen, noteFirstTexts, seenWordings } from "../src/texts/seen.ts";
import { writeState } from "../src/storage/store.ts";
import { initializeDatabase } from "../src/storage/database.ts";

const render = (template: string, values: Record<string, string> = {}): string => renderTemplate(template, new Map(Object.entries(values)));

test("a template's values go in once, as given, whatever is in them", () => {
  expect(render("Hi {{user}}, I'm {{char}}.", { user: "Eve", char: "Ada" })).toBe("Hi Eve, I'm Ada.");
  expect(render("[{{status}}]", { status: "{{user}} {{#if user}}x{{/if}}", user: "Eve" })).toBe("[{{user}} {{#if user}}x{{/if}}]");
  expect(render("{{#if a}}<{{a}}>{{/if}}", { a: "{{b}}", b: "no" })).toBe("<{{b}}>");
  expect(render("{{nobody}} and {{ user }} stay", { user: "Eve" })).toBe("{{nobody}} and {{ user }} stay");
  expect(render("{{{user}}}", { user: "Eve" })).toBe("{Eve}");
  expect(render("")).toBe("");
});

test("a block is kept when its value is set and not empty, and its else part otherwise, and blocks can sit inside blocks", () => {
  const block = "{{#if a}}A{{#if b}}+B{{else}}-B{{/if}}{{else}}none{{/if}}.";
  expect(render(block, { a: "1", b: "1" })).toBe("A+B.");
  expect(render(block, { a: "1", b: "" })).toBe("A-B.");
  expect(render(block, { a: "1" })).toBe("A-B.");
  expect(render(block, { a: "", b: "1" })).toBe("none.");
  expect(render("{{#if  a }}yes{{/if}}", { a: "x" })).toBe("yes");
  expect(render("[{{#if a}}yes{{/if}}]")).toBe("[]");
});

test("a block left open, a stray end or else, and a second else are left as written, with the values around them filled in", () => {
  expect(render("{{#if a}}open {{user}} {{#if b}}inner{{else}}other", { user: "Eve", b: "1" })).toBe("{{#if a}}open Eve {{#if b}}inner{{else}}other");
  expect(render("{{#if a}}one{{else}}two", { a: "1" })).toBe("{{#if a}}one{{else}}two");
  expect(render("x{{/if}} y{{else}} {{user}}", { user: "Eve" })).toBe("x{{/if}} y{{else}} Eve");
  expect(render("{{#if a}}one{{else}}two{{else}}three{{/if}}", { a: "" })).toBe("two{{else}}three");
});

test("a text is Shore's wording until config points it at a file, which is read once, without one newline at its end, or switches it off", async () => {
  const dir = await mkdtemp(testTmp("texts-"));
  await mkdir(join(dir, "mine"));
  await writeFile(join(dir, "mine", "time.md"), "[it is {{now}}]\n\n");
  const texts = new Texts({ time: "mine/time.md", status: false, wake_running: undefined }, dir);
  expect(texts.wording("time")).toBe("[it is {{now}}]\n");
  expect(texts.wording("status")).toBeUndefined();
  expect(texts.wording("wake_running")).toBe(required(TEXT_SPECS.get("wake_running")).shipped);
  await writeFile(join(dir, "mine", "time.md"), "changed\n");
  expect(texts.render("time", { now: "noon" })).toBe("[it is noon]\n");
  expect(Texts.of({ app: { texts: { time: "mine/time.md" } }, dirs: { config: dir } }).render("time")).toBe("changed");
});

test("texts sent elsewhere as their overrides alone come back with the same wording, switched off where they were", async () => {
  const dir = await mkdtemp(testTmp("texts-overrides-"));
  await writeFile(join(dir, "time.md"), "[at {{now}}]\n");
  const overrides = new Texts({ time: "time.md", status: false }, dir).overrides();
  expect(overrides).toEqual({ time: "[at {{now}}]", status: null });
  const back = Texts.from(overrides);
  expect([back.render("time", { now: "noon" }), back.render("status"), back.wording("wake_running")]).toEqual(["[at noon]", undefined, required(TEXT_SPECS.get("wake_running")).shipped]);
});

test("a text is given its values, a value left unset reads as empty, and a text that comes out blank is left out, or refused where Shore needs it", async () => {
  const dir = await mkdtemp(testTmp("texts-"));
  await writeFile(join(dir, "blank.md"), "{{#if now}}{{now}}{{/if}}  \n");
  const texts = new Texts({ time: "blank.md", earlier_not_shown: "blank.md", status: false }, dir);
  expect(texts.render("time", { now: "noon" })).toBe("noon  ");
  expect(texts.render("time", { now: undefined })).toBeUndefined();
  expect(texts.render("status")).toBeUndefined();
  expect(() => texts.always("earlier_not_shown")).toThrow("text \"earlier_not_shown\" came out empty, and Shore can't leave it out");
  expect(() => texts.always("status")).toThrow("text \"status\" came out empty, and Shore can't leave it out");
  expect(new Texts().render("wake_turn", { at: undefined })).toBe("[wake]");
  expect(new Texts().always("wake_turn", { at: "noon" })).toBe("[wake · noon]");
});

test("a file of the user's that can't be read, or a name Shore has no text for, is refused before anything is sent", async () => {
  const dir = await mkdtemp(testTmp("texts-"));
  expect(() => new Texts({ time: "gone.md" }, dir)).toThrow(`text "time" could not be read at ${join(dir, "gone.md")}: `);
  expect(() => new Texts({ nope: false }, dir)).toThrow('Shore has no text named "nope"');
  expect(() => new Texts().wording("nope")).toThrow('Shore has no text named "nope"');
  expect(() => Texts.from({ nope: null })).toThrow('Shore has no text named "nope"');
  expect(() => shippedText("nope")).toThrow('Shore has no text named "nope"');
  expect(shippedText("output_cut")).toBe("[process output truncated]");
});

async function configWith(body: string): Promise<{ dir: string; load: () => ReturnType<typeof loadConfig> }> {
  const dir = await mkdtemp(testTmp("texts-config-"));
  await writeFile(join(dir, "config.toml"), body);
  return { dir, load: () => loadConfig(join(dir, "config.toml"), { env: { SHORE_CONFIG_DIR: dir, SHORE_DATA_DIR: join(dir, "data"), SHORE_CACHE_DIR: join(dir, "cache") }, onWarn: () => {} }) };
}

test("config points a text at a file or switches it off, and refuses a name Shore has none for and a needed text switched off", async () => {
  const fine = await configWith('[texts]\ntime = "texts/time.md"\nstatus = false\nlabel = "texts/label.md"\n');
  expect(fine.load().app.texts).toEqual({ time: "texts/time.md", status: false, label: "texts/label.md" });
  const refused = async (body: string): Promise<string> => {
    const { dir, load } = await configWith(body);
    try {
      load();
    } catch (error) {
      return (error as Error).message.replace(dir, "<dir>");
    }
    return "";
  };
  expect(await refused('[texts]\nnope = "x.md"\n')).toBe("<dir>/config.toml: unknown field `texts.nope`");
  expect(await refused("[texts]\nearlier_not_shown = false\n")).toBe("<dir>/config.toml: texts.earlier_not_shown: invalid type: boolean `false`, expected a file path; this text can't be switched off");
  expect(await refused("[texts]\ntime = 3\n")).toBe("<dir>/config.toml: texts.time: invalid type: integer `3`, expected a file path, or false to switch it off");
});

test("the list names every text with whose wording is in use, a file of the user's that can't be read with why, and the CLI's own texts", async () => {
  const dir = await mkdtemp(testTmp("texts-list-"));
  await writeFile(join(dir, "time.md"), "[now: {{now}}]\n");
  const listed = listTexts({ app: { texts: { time: "time.md", status: false, label: "gone.md" } }, dirs: { config: dir } }, undefined).texts;
  const row = (name: string) => required(listed.find((entry) => entry.name === name));
  expect(row("time")).toEqual({
    name: "time", place: required(TEXT_SPECS.get("time")).where, owner: "yours", required: false, wording: "[now: {{now}}]", shipped: "[{{now}}]",
    file: join(dir, "time.md"), error: null, values: [{ name: "now", about: "the time, like Friday 2026-10-30 · 12:00 PM, with the day named as weekday has it" }], changed: false, previous: null,
  });
  expect([row("status").owner, row("status").wording, row("status").shipped]).toEqual(["off", null, "[Their status: {{statuses}}]"]);
  expect([row("label").owner, row("label").wording, row("label").required, row("label").error]).toEqual(["yours", null, true, `text "label" could not be read at ${join(dir, "gone.md")}: ENOENT: no such file or directory, open '${join(dir, "gone.md")}'`]);
  expect([row("wake").owner, row("wake").wording === row("wake").shipped, row("wake").file, row("wake").changed, row("wake").previous]).toEqual(["shore", true, null, false, null]);
  expect([row("output_cut").owner, row("output_cut").wording, row("output_cut").values]).toEqual(["shore", "[process output truncated]", []]);
  const { place, ...identity } = row("cli_identity");
  expect(place).toStartWith("The first line of the system prompt on claude_agent.");
  expect(identity).toEqual({
    name: "cli_identity", owner: "cli", required: false,
    wording: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", shipped: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", file: null, error: null, values: [],
    changed: false, previous: null,
  });
  expect(row("cli_nudges").wording).toContain("Your tool call was malformed and could not be parsed. Please retry.");
});

test("a text of Shore's whose wording changed since it was last marked seen says so with the wording before, a new one says it is new, and one the user replaced or switched off says nothing", async () => {
  const dir = await mkdtemp(testTmp("texts-seen-"));
  await writeFile(join(dir, "time.md"), "[now: {{now}}]\n");
  const seen = Object.fromEntries(TEXTS.filter((spec) => spec.name !== "wake_turn").map((spec) => [spec.name, spec.shipped]));
  const listed = listTexts({ app: { texts: { time: "time.md", status: false } }, dirs: { config: dir } }, {
    ...seen, wake: "Wake up.", time: "[old {{now}}]", status: "[old status]",
  }).texts;
  const row = (name: string) => required(listed.find((entry) => entry.name === name));
  expect([row("wake").changed, row("wake").previous]).toEqual([true, "Wake up."]);
  expect([row("wake_turn").changed, row("wake_turn").previous]).toEqual([true, null]);
  expect([row("time").changed, row("time").previous, row("status").changed, row("status").previous]).toEqual([false, null, false, null]);
  expect([row("picture").changed, row("picture").previous, row("cli_identity").changed]).toEqual([false, null, false]);
  expect(listed.filter((entry) => entry.changed).map((entry) => entry.name).sort()).toEqual(["wake", "wake_turn"]);
});

test("Shore keeps the wording it first runs with, keeps it until the user marks the list seen, and then keeps the wording it has now", async () => {
  const data = await mkdtemp(testTmp("texts-seen-data-"));
  initializeDatabase(data);
  expect(seenWordings(data)).toBeUndefined();
  writeState(data, "texts_seen.json", JSON.stringify({ wake: "Wake up." }));
  noteFirstTexts(data);
  expect(seenWordings(data)).toEqual({ wake: "Wake up." });
  markTextsSeen(data);
  expect(seenWordings(data)).toEqual(Object.fromEntries(TEXTS.map((spec) => [spec.name, spec.shipped])));
  const fresh = await mkdtemp(testTmp("texts-seen-fresh-"));
  initializeDatabase(fresh);
  noteFirstTexts(fresh);
  expect(seenWordings(fresh)).toEqual(Object.fromEntries(TEXTS.map((spec) => [spec.name, spec.shipped])));
});

test("each text's key in config says where the text goes, and whether it can be switched off, and no other key takes a text's description", () => {
  const entries = configSchema({ instancesAt: (path) => path === "mcp" ? ["time"] : [] });
  const described = (key: string): string | undefined => entries.find((entry) => entry.key === key)?.description;
  expect(described("texts.time")).toBe(required(TEXT_SPECS.get("time")).where);
  expect(described("texts.label")).toBe(`${required(TEXT_SPECS.get("label")).where} It can't be switched off.`);
  expect(described("texts.thread")).toBe(required(TEXT_SPECS.get("thread")).where);
  expect(described("mcp.time.command")).toBe("command for mcp.");
});

test("a tool's text and each of its parameters' texts are named after the tool and the parameter", () => {
  expect([toolText("read"), parameterText("read", "file_path")]).toEqual(["tool_read", "tool_read_file_path"]);
  expect(required(TEXT_SPECS.get("tool_read_file_path")).where).toBe("The description of the file_path parameter of read.");
});

test("a parameter's text switched off leaves that parameter undescribed, and a description goes ahead of the parameter's default", async () => {
  const one = (texts: Texts, name: string): Record<string, Record<string, unknown>> =>
    required(renderedTools(texts, ALL_TOOLS.filter((tool) => tool.name === name), {})[0]).input_schema["properties"] as Record<string, Record<string, unknown>>;
  expect(Object.keys(required(one(new Texts(), "activity_heatmap")["days"]))).toEqual(["type", "description", "default"]);
  const read = one(new Texts({ tool_read_file_path: false }), "read");
  expect([Object.keys(required(read["file_path"])), Object.keys(required(read["offset"]))]).toEqual([["type", "minLength"], ["type", "minimum", "description"]]);
});
