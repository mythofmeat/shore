import { expect, test } from "bun:test";
import { reliabilityGeneration } from "./support/reliability_generation.ts";
import { parseToolArgs } from "../src/llm/tool_args.ts";
import type { SidecarProvider, StreamEvent } from "../src/llm/types.ts";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { runProcess } from "../src/tools/process.ts";

const TOOL = "mcp__audit__optional";
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
const timing = { total_ms: 1, time_to_first_token_ms: 1 };

function providerFor(input: ReturnType<typeof parseToolArgs>, completedBlocks = false): SidecarProvider {
  let calls = 0;
  return {
    generate: async () => { throw new Error("stream required"); },
    async *stream(): AsyncIterable<StreamEvent> {
      if (calls++ === 0) {
        yield { type: "tool_use", id: "call", name: TOOL, ...input };
        yield { type: "done", content: "", finish_reason: "tool_use", usage, timing,
          ...(completedBlocks ? { content_blocks: [{ type: "tool_use", id: "call", name: TOOL, input: input.input }] } : {}),
        };
      } else {
        yield { type: "done", content: "done", finish_reason: "end_turn", usage, timing };
      }
    },
  };
}

test("cancelling generation reaches an in-flight MCP tool", async () => {
  const h = await reliabilityGeneration(providerFor({ input: {} }));
  h.config.app.tools.enabled_tools = [TOOL];
  const parent = new AbortController();
  let observed: AbortSignal | undefined;
  const mcp = { call: async (_name: string, _input: unknown, signal?: AbortSignal) => {
    observed = signal;
    parent.abort();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    return "settled";
  } };
  h.deps.mcpRegistry = { ...mcp, toolDefsFiltered: () => [{ name: TOOL, description: "optional filters", input_schema: { type: "object" } }] };
  h.deps.tools = () => ({ mcpRegistry: mcp });
  const failure = await h.run(parent.signal).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeDefined();
  expect(observed).toBeDefined();
  expect(observed?.aborted).toBe(true);
});

test("process cancellation kills and reaps a child that ignores SIGTERM", async () => {
  const h = await reliabilityGeneration(providerFor({ input: {} }));
  const ready = join(h.root, "ready");
  const parent = new AbortController();
  const work = runProcess(process.execPath, ["-e", `
    process.on("SIGTERM", () => {});
    await Bun.write(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `, ready], { signal: parent.signal });
  const outcome = work.catch((error: unknown) => error);
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { pid = Number(await readFile(ready, "utf8")); break; } catch {}
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  parent.abort();
  expect(await outcome).toBe(parent.signal.reason);
  expect(pid).toBeDefined();
  expect(() => process.kill(pid ?? 0, 0)).toThrow();
});
