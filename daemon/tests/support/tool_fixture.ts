import type { SidecarProvider } from "../../src/llm/types.ts";

export const toolFixture: SidecarProvider["stream"] = async function* (request) {
  yield { type: "start", model: request.model };
  const read = request.messages.at(-1)?.content.some((block) => block.type === "tool_result" && block.tool_use_id === "tool-fixture-read") === true;
  if (!read) yield { type: "tool_use", id: "tool-fixture-read", name: "bash", input: { command: "cat SOUL.md" } };
  else yield { type: "text", text: "Inspected the fixture workspace" };
  yield { type: "done", content: read ? "Inspected the fixture workspace" : "", finish_reason: read ? "end_turn" : "tool_use", usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
};
