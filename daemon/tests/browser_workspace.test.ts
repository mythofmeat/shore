import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { commandCatalogue } from "../src/commands/registry.ts";
import { actionControl, controlFor, initialValue } from "../src/browser/forms.ts";
import { mergeHistory, EVENT_POLICIES, inspectableRequest } from "../src/browser/workspace.ts";
import { configSchema } from "../src/config/schema.ts";
import { formatConfigPath } from "../src/config/surface.ts";
import { assertSettingsCoverage, configAt, settingControl } from "../src/browser/settings_forms.ts";
import { assertModelSettingsCoverage } from "../src/browser/model_forms.ts";
import { settingSchema } from "../src/llm/settings.ts";
import { SDK_VARIANTS } from "../src/llm/types.ts";
import { assertRequestPhaseCoverage, assertArchivePhaseCoverage, assertBrowserCoverage, assertCompactionResultCoverage, assertUsageResultCoverage, switchCases } from "../scripts/browser_coverage.ts";
import type { Message } from "../src/protocol/Message.ts";
import type { OperationDescriptor } from "../src/protocol/OperationDescriptor.ts";
import { assertToolControlCoverage, toolControl, toolNames } from "../src/browser/tool_forms.ts";
import { ALL_TOOLS, SUBAGENT_INPUT_SCHEMA } from "../src/tools/registry.ts";
import toolResults from "../../client/shore-cli/tests/fixtures/tool_results.json" with { type: "json" };

test("every archive transfer phase has a renderer and omitting uncertain outcomes fails coverage", async () => {
  const source = await readFile(new URL("../src/browser/archives.tsx", import.meta.url), "utf8");
  const cases = await switchCases(source, "ArchiveStatus", "archive.phase");
  expect(() => assertArchivePhaseCoverage(cases)).not.toThrow();
  const omitted = await switchCases(source.replace('case "uncertain":', ''), "ArchiveStatus", "archive.phase");
  expect(() => assertArchivePhaseCoverage(omitted)).toThrow("Missing archive phase renderer: uncertain");
});

test("every usage report mode has a renderer and omitting an export fails coverage", async () => {
  const source = await readFile(new URL("../src/browser/usage.tsx", import.meta.url), "utf8");
  expect(() => assertUsageResultCoverage(new Set())).toThrow("Missing usage result renderer");
  const cases = await switchCases(source, "UsageReport", "result.mode");
  expect(() => assertUsageResultCoverage(cases)).not.toThrow();
  const omitted = await switchCases(source.replace('case "tsv":', ''), "UsageReport", "result.mode");
  expect(() => assertUsageResultCoverage(omitted)).toThrow("Missing usage result renderer: tsv");
});

test("built-in, subagent and connected tool schemas reach structured controls and omissions fail", async () => {
  const schemas = [...ALL_TOOLS.map((tool) => ({ name: tool.name, schema: tool.parameters })), { name: "ask_worker", schema: SUBAGENT_INPUT_SCHEMA }, { name: "mcp__fixture__nested", schema: toolResults[0]?.input_schema }];
  const components = await readFile(new URL("../src/browser/components.tsx", import.meta.url), "utf8");
  const renderers = await switchCases(components, "Field", "control.kind");
  expect(() => assertToolControlCoverage(schemas, renderers)).not.toThrow();
  for (const kind of ["array", "object", "boolean", "string", "integer", "json", "union", "null"]) {
    expect(() => assertToolControlCoverage(schemas, new Set([...renderers].filter((renderer) => renderer !== kind)))).toThrow(`.${kind}`);
  }
  const shape = toolControl({ type: "object", properties: { query: { type: "string" }, count: { type: "integer", default: 5 } }, required: ["query"], additionalProperties: { type: "string" } });
  expect(initialValue(shape)).toEqual({ query: "" });
  expect(shape.fields["query"]).toMatchObject({ multiline: true });
  expect(shape.hints?.["count"]).toContain("Default: 5");
  expect(shape.additional).toMatchObject({ kind: "string" });
  expect(toolControl({ type: "object", additionalProperties: { type: "string" }, propertyNames: { type: "string" } }).additional).toMatchObject({ kind: "string" });
  expect(() => toolControl({ type: "object", propertyNames: { type: "string", pattern: "^field" } })).toThrow("Constrained object keys");
  expect(() => toolControl({ type: "object", patternProperties: { "^key": { type: "string" } } })).toThrow("patternProperties");
  expect(toolNames({ tools: [{ tool: "read", main: true, subagents: [] }], subagents: [{ name: "worker", enabled: false, model: null, tools: [] }], mcp: ["mcp__fixture__nested", "read"], warnings: [] })).toEqual(["ask_worker", "mcp__fixture__nested", "read"]);
});

test("every canonical compaction outcome has a dedicated renderer and omissions fail", async () => {
  const source = await readFile(new URL("../src/browser/memory.tsx", import.meta.url), "utf8");
  const cases = await switchCases(source, "CompactionResult", "result.status");
  expect(() => assertCompactionResultCoverage(cases)).not.toThrow();
  const omitted = await switchCases(source.replace('case "paused":', ''), "CompactionResult", "result.status");
  expect(() => assertCompactionResultCoverage(omitted)).toThrow("Missing compaction result renderer: paused");
});

test("live model settings cover every provider kind, including structured vendor controls", async () => {
  const entries = SDK_VARIANTS.flatMap((sdk) => settingSchema(sdk));
  const components = await readFile(new URL("../src/browser/components.tsx", import.meta.url), "utf8");
  const renderers = await switchCases(components, "Field", "control.kind");
  expect(entries.some((entry) => entry.kind === "json_object" && entry.applicability === "honored")).toBe(true);
  expect(() => assertModelSettingsCoverage(entries, renderers)).not.toThrow();
  const missing = await switchCases(components.replace('case "json": return <JsonValue value={value} change={change} label={label} />;', ''), "Field", "control.kind");
  expect(() => assertModelSettingsCoverage(entries, missing)).toThrow("Missing model setting renderer: json");
  expect(await switchCases(components, "JsonValue", "kind")).toEqual(new Set(["string", "number", "boolean", "object", "array", "null"]));
  expect(controlFor(true)).toEqual({ kind: "json" });
  expect(controlFor({})).toEqual({ kind: "json" });
  for (const invalid of [false, null, [], "json"]) expect(() => controlFor(invalid)).toThrow("Invalid action schema");
});

test("all live settings reach controls, with explicit failure for missing renderers or unknown kinds", async () => {
  const entries = configSchema({ instancesAt: (key) => key === "mcp" ? ["fixture"] : key === "mcp.fixture.env" ? ["TOKEN"] : key === "subagents" ? ["worker"] : [] });
  const components = await readFile(new URL("../src/browser/components.tsx", import.meta.url), "utf8");
  const renderers = await switchCases(components, "Field", "control.kind");
  expect(entries.length).toBeGreaterThan(100);
  expect(() => assertSettingsCoverage(entries, renderers)).not.toThrow();
  const missing = await switchCases(components.replace('case "integer": case "number":', 'case "number":'), "Field", "control.kind");
  expect(() => assertSettingsCoverage(entries, missing)).toThrow("Missing settings renderer: integer");
  const secret = entries.find((entry) => entry.key === "mcp.fixture.env.TOKEN");
  if (secret === undefined) throw new Error("Missing secret field");
  expect(secret.secret).toBe(true);
  expect(() => settingControl({ ...secret, kind: "unknown" })).toThrow("Unsupported editable setting");
  expect(configAt({ tools: { enabled_tools: ["read"] } }, "tools.enabled_tools")).toEqual(["read"]);
  expect(configAt({}, "__proto__.polluted")).toBeNull();
});

test("setting lookup follows canonical quoted configuration components", () => {
  for (const model of ["anthropic:fast-fixture", "vendor:model.v2", 'model."quoted"\\path', "", "unicode-模型", "line\nbreak"]) {
    const config = { chat: { [model]: { max_output_tokens: 4096 } } };
    const key = formatConfigPath(["chat", model, "max_output_tokens"]);
    expect(configAt(config, key)).toBe(4096);
    expect(configAt(config, formatConfigPath(["chat", model, "missing"]))).toBeNull();
  }
  expect(configAt({}, '"__proto__".polluted')).toBeNull();
  for (const key of ["chat..model", 'chat."unterminated', ".chat", "chat."]) expect(configAt({}, key)).toBeNull();
});

test("uncertain configuration requests retain their key and hide submitted values", () => {
  const request = { type: "command", name: "config", args: { key: "notifications.ntfy.token", value: "private-secret" } } as const;
  expect(inspectableRequest(request)).toEqual({ ...request, args: { key: "notifications.ntfy.token", value: "<redacted>" } });
  expect(request.args.value).toBe("private-secret");
});

test("every registered action field reaches an implemented control, and every known event has a handler", async () => {
  const [components, workspace] = await Promise.all([
    readFile(new URL("../src/browser/components.tsx", import.meta.url), "utf8"), readFile(new URL("../src/browser/workspace.ts", import.meta.url), "utf8"),
  ]);
  const renderers = await switchCases(components, "Field", "control.kind");
  const events = await switchCases(workspace, "#receive", "message.type");
  const operations: OperationDescriptor[] = commandCatalogue();
  expect(() => assertBrowserCoverage(operations, renderers, events)).not.toThrow();
  const omittedRenderer = await switchCases(components.replace('case "integer": case "number":', 'case "number":'), "Field", "control.kind");
  expect(() => assertBrowserCoverage(operations, omittedRenderer, events)).toThrow("Missing GUI control renderer: integer");
  const omittedEvent = await switchCases(workspace.replace('case "send_image":', ""), "#receive", "message.type");
  expect(() => assertBrowserCoverage(operations, renderers, omittedEvent)).toThrow("Missing GUI event handling: send_image");
  const { tool_call: _omitted, ...policies } = EVENT_POLICIES;
  expect(() => assertBrowserCoverage(operations, renderers, events, policies)).toThrow("Missing GUI event handling: tool_call");
  const fork = operations.find((operation) => operation.name === "fork_thread");
  if (fork === undefined) throw new Error("Missing fork action");
  const { turns: _turns, ...fields } = fork.fields;
  expect(() => actionControl({ ...fork, fields })).toThrow("Unaccounted GUI fields: fork_thread");
  expect(() => controlFor({ type: "string", format: "date", pattern: "pattern-needing-a-renderer" })).toThrow("Unsupported action schema keyword: pattern");
  expect(controlFor({ type: "object", additionalProperties: true })).toMatchObject({ kind: "object", additional: { kind: "json" } });
  expect(initialValue(actionControl(fork))).toEqual({ name: "" });
});

const message = (id: string): Message => ({ msg_id: id, role: "user", content: id, images: [], content_blocks: [], timestamp: "now" });
test("history deltas replace the suffix, preserve archived pages, and detect absent anchors", () => {
  const previous = [message("archive"), message("question"), message("old-answer")];
  const history = { messages: [message("new-answer")], config: {}, revision: 2, delta: { base_revision: 1, after: "question" } };
  expect(mergeHistory(previous, 1, history)?.map((item) => item.msg_id)).toEqual(["archive", "question", "new-answer"]);
  expect(mergeHistory(previous, 1, { ...history, delta: { ...history.delta, after: null } })?.map((item) => item.msg_id)).toEqual(["archive", "new-answer"]);
  expect(mergeHistory(previous, 1, { ...history, delta: { ...history.delta, after: "missing" } })).toBeUndefined();
});

test("history deltas retain image bytes omitted by the daemon's incremental frames", () => {
  const previous = [{ ...message("image"), images: [{ path: "stable.png", data: "aW1hZ2U=" }] }];
  const history = { messages: [{ ...message("image"), images: [{ path: "stable.png" }] }], config: {}, revision: 2, delta: { base_revision: 1, after: null } };
  expect(mergeHistory(previous, 0, history)?.at(0)?.images).toEqual([{ path: "stable.png", data: "aW1hZ2U=" }]);
  expect(mergeHistory(previous, 0, { ...history, messages: [{ ...message("image"), images: [{ path: "stable.png", data: "bmV3" }] }] })?.at(0)?.images).toEqual([{ path: "stable.png", data: "bmV3" }]);
});

test("request outcome renderers cover every canonical phase and reject an omitted uncertainty renderer", async () => {
  const source = await readFile(new URL("../src/browser/requests.tsx", import.meta.url), "utf8");
  const cases = await switchCases(source, "RequestStatus", "request.phase");
  expect(() => assertRequestPhaseCoverage(cases)).not.toThrow();
  const omitted = await switchCases(source.replace('case "uncertain":', ''), "RequestStatus", "request.phase");
  expect(() => assertRequestPhaseCoverage(omitted)).toThrow("Missing request phase renderer: uncertain");
});

test("every core request and nested field reaches a browser route and control, with omissions rejected", async () => {
  const { requestCatalogue } = await import("../src/operations/requests.ts");
  const { assertCoreRequestCoverage } = await import("../scripts/browser_coverage.ts");
  const [components, app] = await Promise.all([
    readFile(new URL("../src/browser/components.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/app.tsx", import.meta.url), "utf8"),
  ]);
  const controls = await switchCases(components, "Field", "control.kind");
  const routes = await switchCases(app, "openRequest", "name");
  const requests = requestCatalogue();
  expect(() => assertCoreRequestCoverage(requests, controls, routes)).not.toThrow();
  for (const request of requests) {
    expect(() => assertCoreRequestCoverage(requests.filter((item) => item !== request), controls, routes)).toThrow(`Missing GUI conversation action: ${request.name}`);
    expect(() => assertCoreRequestCoverage(requests, controls, new Set([...routes].filter((name) => name !== request.name)))).toThrow(`Missing GUI conversation action: ${request.name}`);
    for (const key of Object.keys(request.fields)) {
      const omitted = { ...request, fields: Object.fromEntries(Object.entries(request.fields).filter(([name]) => name !== key)) };
      expect(() => assertCoreRequestCoverage(requests.map((item) => item === request ? omitted : item), controls, routes)).toThrow("Unaccounted GUI fields");
    }
  }
  for (const kind of ["string", "boolean", "array", "object", "integer", "union", "null"]) {
    expect(() => assertCoreRequestCoverage(requests, new Set([...controls].filter((item) => item !== kind)), routes)).toThrow(`Missing GUI control renderer: ${kind}`);
  }
});
