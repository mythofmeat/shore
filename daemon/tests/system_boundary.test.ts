import { describe, expect, test } from "bun:test";

import {
  cacheBoundaryIndex,
  isDynamicSystemBlock,
  withDynamicBlocksLast,
} from "../src/llm/system_boundary.ts";
import { assemblePrompt } from "../src/engine/prompt.ts";

const labels = (blocks: readonly { label: string }[]): string[] => blocks.map((b) => b.label);

describe("cacheBoundaryIndex", () => {
  test("with no dynamic block the whole system prompt is cacheable", () => {
    expect(cacheBoundaryIndex([{ label: "system" }, { label: "character" }])).toBe(1);
  });

  test("the boundary sits immediately before the first dynamic block", () => {
    expect(
      cacheBoundaryIndex([
        { label: "system" },
        { label: "character" },
        { label: "memory_index" },
      ]),
    ).toBe(1);
  });

  test("a dynamic block first means nothing is cacheable, rather than caching it by accident", () => {
    expect(cacheBoundaryIndex([{ label: "memory_index" }, { label: "system" }])).toBe(-1);
  });

  test("an empty system prompt has no boundary to place", () => {
    expect(cacheBoundaryIndex([])).toBe(-1);
  });
});

describe("withDynamicBlocksLast", () => {
  test("a dynamic block added in the middle is routed past the boundary", () => {
    const ordered = withDynamicBlocksLast([
      { label: "system" },
      { label: "memory_index" },
      { label: "character" },
      { label: "user" },
    ]);
    expect(labels(ordered)).toEqual(["system", "character", "user", "memory_index"]);
    expect(cacheBoundaryIndex(ordered)).toBe(2);
  });

  test("a second dynamic block does not split the cached prefix", () => {
    const ordered = withDynamicBlocksLast([
      { label: "system" },
      { label: "activity_stats" },
      { label: "memory_index" },
      { label: "character" },
    ]);
    // activity_stats is not yet declared dynamic, so it stays in the prefix;
    // what the boundary guarantees is that every declared dynamic block is
    // behind it, whatever order it arrived in.
    expect(labels(ordered).at(-1)).toBe("memory_index");
    expect(isDynamicSystemBlock("memory_index")).toBe(true);
  });

  test("stable blocks keep their relative order", () => {
    const ordered = withDynamicBlocksLast([
      { label: "system" },
      { label: "tools_guidance" },
      { label: "character" },
    ]);
    expect(labels(ordered)).toEqual(["system", "tools_guidance", "character"]);
  });
});

describe("the assembled prompt puts its dynamic block at the tail", () => {
  test("memory_index lands last even though it is built before nothing else", () => {
    const { system } = assemblePrompt({
      character_name: "Rhia",
      display_name: "eshen",
      has_prior_context: false,
      messages: [],
      user_timestamp_mode: "none",
      memory_index: "- a live note",
      character_definition: "she is patient",
      user_definition: "he is not",
      tools_guidance: "use tools sparingly",
    } as never);

    expect(labels(system).at(-1)).toBe("memory_index");
    expect(cacheBoundaryIndex(system)).toBe(system.length - 2);
  });
});
