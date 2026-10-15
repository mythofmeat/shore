
import { describe, expect, test } from "bun:test";
import { MAX_THREAD_ID_LENGTH, isValidThreadId } from "../src/engine/threads.ts";

describe("thread ids", () => {
  test("accepts ordinary ids and rejects path-shaped ones", () => {
    expect(isValidThreadId("main")).toBe(true);
    expect(isValidThreadId("agent-sdk-eval")).toBe(true);
    expect(isValidThreadId("v1.2_scratch")).toBe(true);

    expect(isValidThreadId("")).toBe(false);
    expect(isValidThreadId(".")).toBe(false);
    expect(isValidThreadId("..")).toBe(false);
    expect(isValidThreadId("../escape")).toBe(false);
    expect(isValidThreadId("a/b")).toBe(false);
    expect(isValidThreadId("-leading")).toBe(false);
    expect(isValidThreadId("_leading")).toBe(false);
    expect(isValidThreadId("with space")).toBe(false);
    expect(isValidThreadId("a".repeat(MAX_THREAD_ID_LENGTH))).toBe(true);
    expect(isValidThreadId("a".repeat(MAX_THREAD_ID_LENGTH + 1))).toBe(false);
  });
});
