import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseOperationInput, parseOperationResult, type OperationName } from "../src/operations/contracts.ts";
import { OPERATION_RESULTS, OPERATION_RESULTS_CAPTURE } from "./support/operation_results.ts";
import { recordedValue } from "./support/rerecord.ts";

const recorded = JSON.parse(
  readFileSync(join(import.meta.dir, "..", OPERATION_RESULTS_CAPTURE), "utf8"),
) as unknown;

describe("the operation results the Rust client is tested against", () => {
  test("are the daemon's own typed results, recorded for the client", () => {
    for (const [section, value] of Object.entries(OPERATION_RESULTS)) recordedValue(OPERATION_RESULTS_CAPTURE, [section], value);
    expect(recorded).toEqual(JSON.parse(JSON.stringify(OPERATION_RESULTS)) as unknown);
  });

  test("are results the daemon's operation contracts accept", () => {
    const { character_archives, diagnostic_call, diagnostic_status, memory_compaction, memory_segments, tool_results, usage_reports } = OPERATION_RESULTS;
    for (const { name, input, result } of character_archives) {
      expect<unknown>(parseOperationInput(name, input)).toEqual(input);
      expect<unknown>(parseOperationResult(name, result)).toEqual(result);
    }
    const results: (readonly [OperationName, unknown])[] = [
      ["call_log", diagnostic_call],
      ["status", diagnostic_status],
      ["segments", memory_segments],
      ...memory_compaction.map((result) => ["compact", result] as const),
      ...tool_results.map((result) => ["run_tool", result] as const),
      ...usage_reports.map((result) => ["usage", result] as const),
    ];
    for (const [name, result] of results) expect<unknown>(parseOperationResult(name, result)).toEqual(result);
  });
});
