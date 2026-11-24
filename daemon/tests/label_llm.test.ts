import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";

import { RealCompactionLlm } from "../src/memory/compaction/llm.ts";
import type { ResolvedModel } from "../src/llm/request.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import { testTmp } from "./support/tmp.ts";

const REPLY: GenerateResponse = { model: "m", content: "a label", content_blocks: [{ type: "text", text: "a label" }], finish_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
const PICTURE = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } } as const;

function request(pictures: number): SidecarRequest {
  return { sdk: "anthropic", model: "m", messages: [{ role: "user", content: [{ type: "text", text: "label this" }, ...Array.from({ length: pictures }, () => PICTURE)] }] } as unknown as SidecarRequest;
}

async function llm(supportsImages: boolean) {
  const sent: SidecarRequest[] = [];
  const model = { provider_key: "anthropic", model_id: "blind", supports_images: supportsImages } as unknown as ResolvedModel;
  const labeller = new RealCompactionLlm({ model, character: "ada", cacheDir: await mkdtemp(testTmp("shore-label-llm-")), generate: async (outgoing) => { sent.push(outgoing); return REPLY; } });
  return { labeller, sent };
}

test("a model that can't see pictures is sent the label request with each picture swapped for a note", async () => {
  const { labeller, sent } = await llm(false);
  expect(await labeller.generate(request(1))).toBe(REPLY);
  const content = sent[0]?.messages[0]?.content ?? [];
  expect(content.map((block) => block.type)).toEqual(["text", "text"]);
  expect([content[0], content[1]?.type === "text" && content[1].text.includes("anthropic/blind does not accept images")]).toEqual([{ type: "text", text: "label this" }, true]);
  const plain = request(0);
  await labeller.generate(plain);
  expect(sent[1], "a request with no pictures goes as it is").toBe(plain);
});

test("a model that sees pictures gets them", async () => {
  const { labeller, sent } = await llm(true);
  const pictured = request(2);
  await labeller.generate(pictured);
  expect(sent).toEqual([pictured]);
});
