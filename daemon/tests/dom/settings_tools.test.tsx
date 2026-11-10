import { describe, expect, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const PNG = "iVBORw0KGgo=";
const SCHEMA = { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] };
const settle = async () => { await acting(() => Bun.sleep(5)); };
const listing = (tools: [string, boolean][], subagents: string[] = [], mcp: string[] = []) => ({
  tools: tools.map(([tool, main]) => ({ tool, main, subagents: [] })),
  subagents: subagents.map((name) => ({ name, enabled: true, tools: [], model: null })),
  mcp, warnings: [],
});
const definition = (tool: string, schema: unknown = SCHEMA, extra: Record<string, unknown> = {}) => ({ mode: "tool_definition", tool, kind: "builtin", enabled: true, description: `What ${tool} does.`, input_schema: schema, ...extra });
const report = (extra: Record<string, unknown> = {}) => ({ tool: "read_file", character: "ada", kind: "builtin", enabled: true, input: {}, ok: true, rejected: false, duration_ms: 1234, output: "the file", truncated: false, result_chars: 8, raw: null, calls: [], ...extra });

function serve(tools: () => unknown, describing: (tool: string) => unknown, running: () => unknown = () => report()) {
  app.answer((request) => {
    if (request["name"] === "tools") return tools();
    if (request["name"] !== "run_tool") return undefined;
    const args = request["args"] as Record<string, unknown>;
    return args["describe"] === true ? describing(String(args["tool"])) : running();
  });
}

function reply(name: string, data: unknown) {
  const held = app.socket().sent.filter((request) => request["name"] === name).at(-1);
  app.socket().receive({ type: "command_output", rid: held?.["rid"], name, data });
  app.socket().receive({ type: "request_finished", rid: held?.["rid"], outcome: "completed" });
}

async function page(character: string | null = "ada") {
  const { ToolsPage } = await import("../../src/browser/settings/Tools.tsx");
  const view = await mount(<ToolsPage state={{ ...app.state().workspace.getSnapshot(), character }} />);
  await settle();
  return view;
}

const described = (root: ParentNode) => root.querySelector(".tool-runner .setting-description")?.textContent;
const runs = (since: number) => app.sent(since).filter((request) => request["name"] === "run_tool").map((request) => request["args"]);

describe("the tools page", () => {
  test("needs a character, then offers its tools with the enabled ones first and describes the chosen one", async () => {
    const before = app.socket().sent.length;
    serve(() => listing([["zeta", true], ["alpha", false], ["beta", true], ["delta", false]], ["helper"], ["mcp__web__fetch"]), (tool) => definition(tool));
    const none = await page(null);
    expect(none.host.textContent).toBe("Choose a character in the sidebar first; these settings belong to a character.");
    expect(app.sent(before).map((request) => request["name"])).not.toContain("tools");
    const view = await page();
    expect(view.host.querySelector(".settings-description")?.textContent).toBe("Run one of ada’s tools by hand, as the character would. Results aren’t added to the conversation.");
    const select = view.host.querySelector<HTMLSelectElement>("select[aria-label=Tool]");
    expect([...view.host.querySelectorAll("select[aria-label=Tool] option")].map((option) => option.getAttribute("value"))).toEqual(["beta", "zeta", "alpha", "ask_helper", "delta", "mcp__web__fetch"]);
    expect([select?.value, described(view.host)]).toEqual(["beta", "What beta does."]);
    await type(select, "delta");
    await settle();
    expect([select?.value, described(view.host)]).toEqual(["delta", "What delta does."]);
    expect(runs(before)).toEqual([{ tool: "beta", describe: true }, { tool: "delta", describe: true }]);
  });

  test("waits for the listing, and says why it failed or that there are no tools", async () => {
    serve(() => HOLD, (tool) => definition(tool));
    const waiting = await page();
    expect([waiting.host.querySelector(".settings-empty [role=status]") !== null, waiting.host.querySelector("option")]).toEqual([true, null]);
    serve(() => { throw new Error("no tools here"); }, (tool) => definition(tool));
    const failing = await page();
    expect(failing.host.querySelector("[role=alert]")?.textContent).toBe("no tools here");
    serve(() => listing([]), (tool) => definition(tool));
    const empty = await page();
    expect([empty.host.querySelector(".settings-empty")?.textContent, empty.host.querySelector(".tool-runner")]).toEqual(["No tools are available.", null]);
  });

  test("a tool runs only once it is described, which says when it is not enabled or why it could not be read", async () => {
    let describing: (tool: string) => unknown = () => HOLD;
    serve(() => listing([["read_file", true]]), (tool) => describing(tool));
    const view = await page();
    const run = button(view.host, "Run tool");
    expect([view.host.querySelector(".tool-runner [aria-label='Loading tool']") !== null, run.disabled, button(view.host, "Form").disabled, view.host.querySelector(".field-object")]).toEqual([true, true, true, null]);
    reply("run_tool", definition("read_file", SCHEMA, { enabled: false }));
    await settle();
    expect(described(view.host)).toBe("What read_file does. (not enabled for this character)");
    expect([view.host.querySelector("[aria-label='Loading tool']"), run.disabled, button(view.host, "Form").disabled, button(view.host, "Form").getAttribute("aria-checked"), view.host.querySelector(".field-object") !== null]).toEqual([null, false, false, "true", true]);
    describing = () => { throw new Error("cannot describe"); };
    const failing = await page();
    expect([failing.host.querySelector(".tool-runner [role=alert]")?.textContent, failing.host.querySelector("[aria-label='Loading tool']"), button(failing.host, "Run tool").disabled]).toEqual(["cannot describe", null, true]);
    describing = () => report();
    const odd = await page();
    expect([odd.host.querySelector("[aria-label='Loading tool']") !== null, odd.host.querySelector("[role=alert]"), button(odd.host, "Run tool").disabled], "an answer that is not a description is ignored").toEqual([true, null, true]);
  });

  test("runs the tool with the form's values or key=value lines, and with the raw result when asked", async () => {
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); });
    let running: () => unknown = () => HOLD;
    serve(() => listing([["read_file", true]]), (tool) => definition(tool), () => running());
    const view = await page();
    const path = () => view.host.querySelector<HTMLTextAreaElement>("textarea[aria-label=Path]");
    const lines = () => view.host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Arguments as key=value lines']");
    expect([path()?.value, lines()]).toEqual(["", null]);
    await type(path(), "notes.md");
    const before = app.socket().sent.length;
    await click(button(view.host, "Run tool"));
    expect(button(view.host, "Running…").disabled).toBe(true);
    reply("run_tool", report({ output: "first" }));
    await settle();
    expect([button(view.host, "Run tool").disabled, view.host.querySelector(".readout")?.textContent]).toEqual([false, "first"]);
    await click(button(view.host, "key=value lines"));
    expect([button(view.host, "Form").getAttribute("aria-checked"), button(view.host, "key=value lines").getAttribute("aria-checked"), path(), lines()?.getAttribute("rows")]).toEqual(["false", "true", null, "4"]);
    await type(lines(), "path=a.md\nlimit=2");
    await click(view.host.querySelector("input[type=checkbox]"));
    running = () => report({ output: "second" });
    await click(button(view.host, "Run tool"));
    await settle();
    await type(lines(), "nonsense");
    await click(button(view.host, "Run tool"));
    await settle();
    await click(button(view.host, "Form"));
    expect([path()?.value, lines()]).toEqual(["notes.md", null]);
    await click(view.host.querySelector("input[type=checkbox]"));
    running = () => definition("read_file");
    await click(button(view.host, "Run tool"));
    await settle();
    expect(view.host.querySelector(".readout")?.textContent, "an answer that is not a report leaves the last one").toBe("second");
    expect(runs(before)).toEqual([
      { tool: "read_file", input: { path: "notes.md" } },
      { tool: "read_file", pairs: { path: "a.md", limit: "2" }, raw: true },
      { tool: "read_file", input: { path: "notes.md" } },
    ]);
    expect(shown.mock.calls).toEqual([["Use key=value on each line: “nonsense”", "error"]]);
  });

  test("a tool whose arguments the form cannot hold starts on key=value lines", async () => {
    serve(() => listing([["shell", true], ["strict", true]]), (tool) => definition(tool, tool === "shell" ? { type: "string" } : { type: "object", properties: {}, required: ["x"] }));
    const view = await page();
    const state = () => [view.host.querySelector(".tool-runner [role=alert]")?.textContent, button(view.host, "Form").disabled, button(view.host, "key=value lines").getAttribute("aria-checked"), view.host.querySelector("textarea[aria-label='Arguments as key=value lines']") !== null];
    expect([described(view.host), ...state()]).toEqual(["What shell does.", "Tool arguments require an object editor", true, "true", true]);
    await type(view.host.querySelector("select[aria-label=Tool]"), "strict");
    await settle();
    expect(state()).toEqual(["Missing required control: x", false, "true", true]);
    await click(button(view.host, "Form"));
    expect(view.host.querySelector(".field-object")).not.toBeNull();
  });

  test("shows how a run went: outcome, time, output, pictures, nested calls and the raw result", async () => {
    const reports = [
      report({ truncated: true, result_chars: 5000, raw: "{\"raw\":true}",
        images: [{ path: "a.png", data: PNG }, { path: "b.png", data: "not a picture!" }, { path: "c.png", caption: "Cat", data: PNG }],
        calls: [{ tool: "grep", subagent: null, ok: true, input: "in", output: "out" }, { tool: "read", subagent: "helper", ok: false, input: "x", output: "y" }] }),
      report({ ok: false, output: "", images: [{ path: "only.png", data: PNG }], calls: [{ tool: "grep", subagent: null, ok: true, input: "a", output: "b" }] }),
      report({ ok: false, rejected: true, images: [] }),
      report({ output: "plain" }),
    ];
    serve(() => listing([["read_file", true]]), (tool) => definition(tool), () => reports.shift());
    const view = await page();
    await type(view.host.querySelector("textarea[aria-label=Path]"), "x");
    const outcome = async () => {
      await click(button(view.host, "Run tool"));
      await settle();
      const shown = view.host.querySelector(".tool-runner > .rows.padded:last-child");
      const status = shown?.querySelector(".status-text");
      return {
        status: [status?.className, status?.textContent],
        output: shown?.querySelector(":scope > pre.readout")?.textContent,
        pictures: shown?.querySelector(".images") === null ? null : [...shown?.querySelectorAll(".images img") ?? []].map((image) => [image.getAttribute("src"), image.getAttribute("alt")]),
        nested: shown?.querySelector(".tool-label")?.textContent ?? null,
        details: [...shown?.querySelectorAll("details") ?? []].map((item) => [item.querySelector("summary")?.textContent, item.querySelector("pre")?.textContent]),
      };
    };
    const ms = (1234).toLocaleString();
    expect(await outcome()).toEqual({
      status: ["status-text ok", `Finished in ${ms} ms · output truncated to ${(5000).toLocaleString()} characters`], output: "the file",
      pictures: [[`data:image/png;base64,${PNG}`, "a.png"], [`data:image/png;base64,${PNG}`, "Cat"]], nested: "Nested calls",
      details: [["grep ", "in\n\nout"], ["helper → read (failed)", "x\n\ny"], ["Raw result", "{\"raw\":true}"]],
    });
    expect(await outcome()).toEqual({
      status: ["status-text bad", `Failed in ${ms} ms`], output: "(no output)", pictures: [[`data:image/png;base64,${PNG}`, "only.png"]], nested: "Nested calls", details: [["grep ", "a\n\nb"]],
    });
    expect(await outcome()).toEqual({ status: ["status-text bad", `Rejected before running in ${ms} ms`], output: "the file", pictures: null, nested: null, details: [] });
    expect(await outcome()).toEqual({ status: ["status-text ok", `Finished in ${ms} ms`], output: "plain", pictures: null, nested: null, details: [] });
  });
});
