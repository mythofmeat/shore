import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { commandCatalogue } from "../src/commands/registry.ts";
import { actionControl, controlFor, initialValue } from "../src/browser/forms.ts";
import { mergeHistory, EVENT_POLICIES, inspectableRequest } from "../src/browser/workspace.ts";
import { configSchema } from "../src/config/schema.ts";
import { assertSettingsCoverage, configAt, settingControl } from "../src/browser/settings_forms.ts";
import { assertBrowserCoverage, switchCases } from "../scripts/browser_coverage.ts";
import type { Message } from "../src/protocol/Message.ts";
import type { OperationDescriptor } from "../src/protocol/OperationDescriptor.ts";

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
  expect(() => controlFor({ type: "object", additionalProperties: true })).toThrow("Open object inputs need a dedicated control");
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
