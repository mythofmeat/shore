import { describe, expect, test } from "bun:test";
import { commandOperations } from "../src/commands/registry.ts";
import { assertContractBindings, parseOperationResult } from "../src/operations/contracts.ts";
import { defineOperation } from "../src/operations/registry.ts";

const EMPTY_LIST = { character: "ada", threads: [], current: "main", home: "main" };

describe("executable operation contracts", () => {

  test("every canonical operation has exactly one registered handler", () => {
    expect(() => assertContractBindings(Object.keys(commandOperations))).not.toThrow();
    expect(() => assertContractBindings(Object.keys(commandOperations).filter((name) => name !== "fork_thread"))).toThrow("Missing operation handler: fork_thread");
    expect(() => assertContractBindings([...Object.keys(commandOperations), "unregistered"])).toThrow("Missing operation contract: unregistered");
  });

  test("validation precedes the bound handler and a malformed result cannot become success", () => {
    let called = false;
    const operation = defineOperation("fork_thread", commandOperations.fork_thread.presentation, (_context: null, _input) => {
      called = true;
      return { ...EMPTY_LIST, fork: { fork_id: "fk_1", thread: "branch", source: "main", created_at: "now", messages: 2, turns: 1, scope: "full" as const } };
    });
    expect(() => { void operation.invoke(null, { name: "branch", turns: false }); }).toThrow();
    expect(called).toBe(false);
    expect(operation.invoke(null, { name: "branch" })).toMatchObject({ fork: { messages: 2, turns: 1 } });
    expect(called).toBe(true);
    expect(() => parseOperationResult("fork_thread", EMPTY_LIST)).toThrow("Invalid result for fork_thread");
    expect(() => parseOperationResult("create_character", { character: "ada" })).toThrow("Invalid result for create_character");
  });
});
