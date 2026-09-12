import { describe, expect, test } from "bun:test";
import { commandCatalogue, commandOperations, type CommandOperationContext } from "../src/commands/registry.ts";
import { assertContractBindings, parseOperationInput, parseOperationResult } from "../src/operations/contracts.ts";
import { defineOperation, discoverOperations } from "../src/operations/registry.ts";
import { validOperationInput, validOperationResult } from "../src/browser/operation_validators.generated.js";

const EMPTY_LIST = { character: "ada", threads: [], current: "main", home: "main" };

describe("executable operation contracts", () => {
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
