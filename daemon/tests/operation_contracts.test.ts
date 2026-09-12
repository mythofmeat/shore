import { describe, expect, test } from "bun:test";
import { commandCatalogue, commandOperations, type CommandOperationContext } from "../src/commands/registry.ts";
import { assertContractBindings, parseOperationInput, parseOperationResult } from "../src/operations/contracts.ts";
import { defineOperation, discoverOperations } from "../src/operations/registry.ts";
import { validOperationInput, validOperationResult } from "../src/browser/operation_validators.generated.js";

const EMPTY_LIST = { character: "ada", threads: [], current: "main", home: "main" };

describe("executable operation contracts", () => {
  test("diagnostic filters are shared by browser and daemon without string coercion or unsafe IDs", () => {
    for (const [name, input] of [
      ["call_log", { id: -1, against: 0, diff: true, wire: true, character: null, call_type: null, count: 0 }],
      ["transcript", { source: "memory_recall", count: null }],
      ["subagent_trace", { ids: ["parent-1", "parent-2"], count: 0 }],
      ["heartbeat_log", { count: 0 }], ["error_log", {}], ["session_activate", {}],
    ] as const) {
      expect<unknown>(parseOperationInput(name, input)).toEqual(input);
      expect(validOperationInput(name, input)).toBe(true);
    }
    for (const [name, input] of [
      ["call_log", { id: Number.MAX_SAFE_INTEGER + 1 }], ["call_log", { against: Number.MIN_SAFE_INTEGER - 1 }],
      ["call_log", { wire: "true" }], ["call_log", { id: 1.5 }], ["heartbeat_log", { count: -1 }],
      ["error_log", { count: 4294967296 }], ["transcript", { source: "unknown" }],
      ["subagent_trace", { ids: [1] }], ["heartbeat_tick_now", { force: true }],
    ] as const) {
      expect(() => parseOperationInput(name, input)).toThrow();
      expect(validOperationInput(name, input)).toBe(false);
    }
  });

  test("diagnostic result variants require complete metadata while retaining captured and future fields", () => {
    const status = { character: "ada", keepalive_halted: null, message_count: 0, turn_count: 0, active_model: null, config_dir: "/config", data_dir: "/data", cache_dir: "/cache", pending_deferred_edit_count: 0, pending_deferred_edits: [], tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, autonomy: null, activity: null, index: null, history_index: null, sections: ["future_section"], future_section: { visible: true } };
    const summary = { id: 1, call_id: "call-1", ts: "now", call_type: null, character: null, model: null, provider: null, finish_reason: null, duration_ms: null, error: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, request_bytes: 0, response_bytes: 0 };
    for (const [name, result] of [
      ["status", status], ["call_log", { enabled: false, entries: [] }],
      ["call_log", { enabled: true, call: { ...summary, request: { future: [null, true, "text"] }, response: "unparsed response" }, wire: [], future: "visible" }],
      ["transcript", { enabled: true, source: "heartbeat", entries: [] }],
      ["keepalive_ping_now", { status: "skipped", character: "ada", reason: "no request" }],
      ["session_activate", { character: "ada", registered: false, heartbeat: null, keepalive: { status: "unavailable", detail: "No cached prefix" } }],
    ] as const) {
      expect<unknown>(parseOperationResult(name, result)).toEqual(result);
      expect(validOperationResult(name, result)).toBe(true);
    }
    for (const [name, result] of [
      ["status", { ...status, tokens: { input: 0 } }], ["status", { ...status, active_model: undefined }],
      ["call_log", { enabled: true, call: summary, wire: [] }], ["call_log", { enabled: true, entries: [{ ...summary, model: undefined }] }],
      ["keepalive_ping_now", { status: "warm", character: "ada", reason: "wrong variant" }],
      ["session_activate", { character: "ada", registered: true, heartbeat: null, keepalive: { status: "primed", detail: "missing usage" } }],
    ] as const) {
      expect(() => parseOperationResult(name, result)).toThrow();
      expect(validOperationResult(name, result)).toBe(false);
    }
  });

  test("provider contracts preserve nullable filters and require a truthful batch result", () => {
    for (const include_hidden of [true, false, null]) {
      const input = { provider: "fixture", include_hidden };
      expect(parseOperationInput("list_provider_models", input)).toEqual(input);
      expect(validOperationInput("list_provider_models", input)).toBe(true);
    }
    for (const input of [{}, { provider: 1 }, { provider: "fixture", include_hidden: "true" }, { provider: "fixture", extra: true }]) {
      expect(() => parseOperationInput("list_provider_models", input)).toThrow();
      expect(validOperationInput("list_provider_models", input)).toBe(false);
    }
    const success = { provider: "fixture", ok: true, model_count: 2, fetched_at: "now", cache_path: "/cache/models.json" };
    const failure = { provider: "broken", ok: false, error: "Unavailable" };
    const result = { results: [success, failure], skipped: [{ provider: "off", reason: "disabled" }], future: "inspectable" };
    expect<unknown>(parseOperationResult("refresh_all_provider_models", result)).toEqual(result);
    expect(validOperationResult("refresh_all_provider_models", result)).toBe(true);
    for (const invalid of [{ ...success, ok: false }, { ...failure, ok: true }, { ...success, model_count: -1 }]) {
      expect(() => parseOperationResult("refresh_all_provider_models", { results: [invalid], skipped: [] })).toThrow();
      expect(validOperationResult("refresh_all_provider_models", { results: [invalid], skipped: [] })).toBe(false);
    }
  });
  test("conversation optional values preserve the daemon's null and integer semantics in both clients", () => {
    for (const [name, input] of [
      ["log", { turns: 0, count: null, role: "assistant" }],
      ["history_page", { before: "active", count: 1, role: "system" }],
      ["history_page", { before: 0 }],
      ["get", { ref: "-1", role: "user" }],
      ["alt", { ref: null, index: null, position: 2, direction: "previous" }],
      ["delete", { refs: ["1", "last"] }],
      ["delete", { refs: "last" }],
    ] as const) {
      expect<unknown>(parseOperationInput(name, input)).toEqual(input);
      expect(validOperationInput(name, input)).toBe(true);
    }
    for (const [name, input] of [
      ["log", { role: null }], ["get", { ref: "last", role: null }],
      ["history_page", { before: null }], ["log", { before: 1 }],
      ["log", { count: -1 }], ["history_page", { before: Number.MAX_SAFE_INTEGER + 1 }],
      ["alt", { direction: "backwards" }], ["delete", { refs: [1] }],
    ] as const) {
      expect(() => parseOperationInput(name, input)).toThrow();
      expect(validOperationInput(name, input)).toBe(false);
    }
    expect(validOperationResult("get", { ref: "1", edited: true })).toBe(false);
    expect(validOperationResult("edit", { ref: "1", edited: true, future: "inspectable" })).toBe(true);
  });

  test("every canonical operation has exactly one registered handler", () => {
    expect(() => assertContractBindings(Object.keys(commandOperations))).not.toThrow();
    expect(() => assertContractBindings(Object.keys(commandOperations).filter((name) => name !== "fork_thread"))).toThrow("Missing operation handler: fork_thread");
    expect(() => assertContractBindings([...Object.keys(commandOperations), "unregistered"])).toThrow("Missing operation contract: unregistered");
  });

  test("all fork fields have meaningful controls and schema constraints", () => {
    const fork = commandCatalogue().find((operation) => operation.name === "fork_thread");
    expect(fork).toMatchObject({
      scope: "character", prerequisites: ["threads"], effects: ["history_write"],
      fields: { name: { label: "New thread ID" }, from: { choices: "threads" }, turns: { label: "Recent turns" } },
      input: { additionalProperties: false, required: ["name"], properties: { turns: { minimum: 1 } } },
    });
  });

  test("omitting a real field presentation fails discovery", () => {
    const { turns: _removed, ...fields } = commandOperations.fork_thread.presentation.fields;
    const incomplete = {
      ...commandOperations,
      fork_thread: { ...commandOperations.fork_thread, presentation: { ...commandOperations.fork_thread.presentation, fields } },
    };
    // @ts-expect-error every canonical input field requires presentation metadata
    expect(() => discoverOperations(incomplete)).toThrow("Unaccounted operation fields: fork_thread");
  });

  test("null optional arguments from existing clients are retained without coercion", () => {
    expect(parseOperationInput("fork_thread", { name: "branch", from: null, turns: null })).toEqual({ name: "branch", from: null, turns: null });
    expect(parseOperationInput("list_characters", null)).toEqual({});
    expect(() => parseOperationInput("fork_thread", { name: "branch", turns: "2" })).toThrow();
    expect(() => parseOperationInput("fork_thread", { name: "branch", typo: true })).toThrow();
    expect(() => parseOperationInput("fork_thread", { name: "branch", turns: 0 })).toThrow();
    expect(() => parseOperationInput("fork_thread", { name: "branch", turns: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  test("validation precedes the bound handler and a malformed result cannot become success", () => {
    let called = false;
    const operation = defineOperation("fork_thread", commandOperations.fork_thread.presentation, (_context: null, _input) => {
      called = true;
      return { ...EMPTY_LIST, fork: { fork_id: "fk_1", thread: "branch", source: "main", created_at: "now", messages: 2, turns: 1, scope: "full" as const } };
    });
    expect(() => operation.invoke(null, { name: "branch", turns: false })).toThrow();
    expect(called).toBe(false);
    expect(operation.invoke(null, { name: "branch" })).toMatchObject({ fork: { messages: 2, turns: 1 } });
    expect(called).toBe(true);
    expect(() => parseOperationResult("fork_thread", EMPTY_LIST)).toThrow("Invalid result for fork_thread");
    expect(() => parseOperationResult("create_character", { character: "ada" })).toThrow("Invalid result for create_character");
  });

  test("discovery reports actual scope and thread availability", () => {
    const context = { deps: {}, session: {} } as CommandOperationContext;
    const catalogue = commandCatalogue(context);
    expect(catalogue.find((operation) => operation.name === "create_character")?.available).toBe(true);
    expect(catalogue.find((operation) => operation.name === "fork_thread")?.available).toBe(false);
    expect(catalogue.find((operation) => operation.name === "character_info")?.available).toBe(false);
    expect(catalogue.find((operation) => operation.name === "archive_thread")?.confirmation).toBe("archive");
  });
});
