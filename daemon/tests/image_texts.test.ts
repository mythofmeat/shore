import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Content } from "@google/genai";

import type { ContentBlock } from "../src/engine/types.ts";
import { ingestImages } from "../src/handler/images.ts";
import { capRequestImages, MAX_REQUEST_IMAGES, REQUEST_IMAGE_DROP_STEP } from "../src/llm/image_support.ts";
import { requestTexts } from "../src/llm/images.ts";
import { buildRequestWithResolvedKey } from "../src/llm/request.ts";
import { buildGeminiParams } from "../src/llm/providers/gemini.ts";
import { buildOpenAIMessages } from "../src/llm/providers/openai.ts";
import { buildCall } from "../src/llm/providers/vercel.ts";
import { withToolImages } from "../src/llm/tool_images.ts";
import type { SidecarProvider, SidecarRequest, WireMessage } from "../src/llm/types.ts";
import { imageBlobs, withImageData, withImageReferences } from "../src/storage/image_blobs.ts";
import { characterTexts, Texts, useCharacterTexts } from "../src/texts/texts.ts";
import { testTmp } from "./support/tmp.ts";

const GIF = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
const gif = { type: "base64" as const, media_type: "image/gif", data: GIF };
const tiff = { type: "base64" as const, media_type: "image/tiff", data: GIF };

const IMAGE_TEXTS: Record<string, string> = {
  image_omitted: "(no picture: {{image}}, because {{reason}})",
  image_in_message: "a picture in a message",
  image_in_tool_result: "a picture from a tool",
  image_type: "{{type}} won't do",
  image_extension: "{{#if extension}}{{extension}}{{else}}a bare name{{/if}} won't do",
  image_no_data: "it was empty",
  image_too_big: "{{bytes}} > {{limit}}",
  image_not_uploaded: "it never arrived",
  image_not_saved: "it couldn't be kept",
  image_request_cap: "past {{images}} pictures or {{chars}} characters",
  image_text_only: "{{model}} reads only words",
  image_from_tool: "(pictures from {{#if tool}}{{tool}}{{else}}a tool{{/if}}, call {{id}})",
  image_from_tool_one: "(picture from {{tool}}, call {{id}})",
  picture_gone: "(gone: {{name}})",
};

async function theirs(names: readonly string[] = Object.keys(IMAGE_TEXTS), off: readonly string[] = []): Promise<Texts> {
  const dir = await mkdtemp(testTmp("image-texts-"));
  const settings: Record<string, string | false> = {};
  for (const name of names) {
    await writeFile(join(dir, `${name}.md`), `${IMAGE_TEXTS[name] ?? ""}\n`);
    settings[name] = `${name}.md`;
  }
  for (const name of off) settings[name] = false;
  return new Texts(settings, dir);
}

function looked(content: ContentBlock[]): WireMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "look", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content }, { type: "image", source: tiff }, { type: "text", text: "and this?" }] },
  ];
}

function request(sdk: SidecarRequest["sdk"], model: string, messages: WireMessage[], texts?: Texts): SidecarRequest {
  return { sdk, model, api_key: "sk-test", max_tokens: 64, reasoning_replay: "all", messages, ...(texts === undefined ? {} : { texts }) };
}

describe("the image texts on each provider", () => {
  test("OpenAI and the AI SDK put the user's wording before a tool's pictures and in place of a picture they can't send, and Shore's wording without texts on the request", async () => {
    const texts = await theirs();
    const messages = looked([{ type: "text", text: "here" }, { type: "image", source: gif }, { type: "image", source: tiff }]);
    const openai = buildOpenAIMessages(request("openai", "gpt-5", messages, texts)).at(-1) as { content: { type: string; text?: string }[] };
    expect(openai.content.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "(pictures from look, call call_1)", "(no picture: a picture from a tool, because image/tiff won't do)", "(no picture: a picture in a message, because image/tiff won't do)", "and this?",
    ]);
    const vercel = buildCall(request("openrouter", "some/model", messages, texts)).messages?.at(-1) as unknown as { content: { type: string; text?: string }[] };
    expect(vercel.content.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "(pictures from look, call call_1)", "(no picture: a picture from a tool, because image/tiff won't do)", "(no picture: a picture in a message, because image/tiff won't do)", "and this?",
    ]);
    const shipped = buildOpenAIMessages(request("openai", "gpt-5", messages)).at(-1) as { content: { type: string; text?: string }[] };
    expect(shipped.content.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "Images from tool look (tool_call_id: call_1):", "[image omitted: a tool result image — image/tiff is not a supported format]", "[image omitted: an attached image — image/tiff is not a supported format]", "and this?",
    ]);
  });

  test("a tool Shore can't name is the user's wording's own, and texts switched off leave the pictures with no label and the ones that can't go with no note", async () => {
    const orphan: WireMessage[] = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: [{ type: "image", source: gif }, { type: "image", source: tiff }] }] }];
    const named = buildOpenAIMessages(request("openai", "gpt-5", orphan, await theirs())).at(-1) as { content: { type: string; text?: string }[] };
    expect(named.content.map((part) => part.text ?? part.type)).toEqual(["(pictures from a tool, call call_9)", "image_url", "(no picture: a picture from a tool, because image/tiff won't do)"]);
    const off = await theirs([], ["image_from_tool", "image_omitted"]);
    const called: WireMessage[] = [{ role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "look", input: {} }] }, ...orphan];
    const quiet = buildCall(request("openrouter", "some/model", called, off)).messages?.at(-1) as unknown as { content: { type: string; text?: string }[] };
    expect(quiet.content.map((part) => part.text ?? part.type)).toEqual(["image"]);
  });

  test("Gemini labels each of a tool's pictures in the user's wording before Gemini 3, and puts a note for one it can't send in the tool's error", async () => {
    const texts = await theirs();
    const messages = looked([{ type: "text", text: "here" }, { type: "image", source: gif }]);
    expect(buildGeminiParams(request("gemini", "gemini-2.5-pro", messages, texts)).contents).toStrictEqual([
      { role: "model", parts: [{ functionCall: { id: "call_1", name: "look", args: {} } }] },
      { role: "user", parts: [
        { functionResponse: { id: "call_1", name: "look", response: { result: "here" } } },
        { text: "(picture from look, call call_1)" },
        { inlineData: { mimeType: "image/gif", data: GIF } },
        { text: "(no picture: a picture in a message, because image/tiff won't do)" },
        { text: "and this?" },
      ] },
    ]);
    const failed = (buildGeminiParams(request("gemini", "gemini-3-pro", looked([{ type: "text", text: "here" }, { type: "image", source: tiff }]), texts)).contents as Content[]).at(-1);
    expect(failed?.parts?.[0]).toStrictEqual({ functionResponse: { id: "call_1", name: "look", response: { error: "here\n(no picture: a picture from a tool, because image/tiff won't do)" } } });
    const off = await theirs([], ["image_from_tool_one", "image_omitted"]);
    expect((buildGeminiParams(request("gemini", "gemini-2.5-pro", messages, off)).contents as Content[]).at(-1)?.parts).toStrictEqual([
      { functionResponse: { id: "call_1", name: "look", response: { result: "here" } } },
      { inlineData: { mimeType: "image/gif", data: GIF } },
      { text: "and this?" },
    ]);
  });

  test("an empty picture and one too big for any model are named in the user's wording", async () => {
    const texts = await theirs();
    const empty = { type: "base64" as const, media_type: "image/png", data: "" };
    const huge = { type: "base64" as const, media_type: "image/png", data: "A".repeat(7_000_000) };
    const sent = buildOpenAIMessages(request("openai", "gpt-5", [{ role: "user", content: [{ type: "image", source: empty }, { type: "image", source: huge }] }], texts)).at(-1) as { content: { text?: string }[] };
    expect(sent.content.map((part) => part.text)).toEqual(["(no picture: a picture in a message, because it was empty)", "(no picture: a picture in a message, because 5250000 > 5242880)"]);
  });
});

describe("pictures left out of a request", () => {
  const imageMessage = (data = "A"): WireMessage => ({ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] });

  test("pictures past what a request can carry are noted in the user's wording, or dropped with no note when it is switched off", async () => {
    const history = [...Array.from({ length: MAX_REQUEST_IMAGES + 1 }, () => imageMessage()), { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t", content: [{ type: "image" as const, source: gif }] }] }];
    const capped = capRequestImages(await theirs(), history);
    expect(capped.stripped).toBe(REQUEST_IMAGE_DROP_STEP);
    expect(capped.messages[0]?.content).toEqual([{ type: "text", text: "(no picture: a picture in a message, because past 100 pictures or 20000000 characters)" }]);
    const quiet = capRequestImages(await theirs([], ["image_omitted"]), history);
    expect(quiet.stripped).toBe(REQUEST_IMAGE_DROP_STEP);
    expect(quiet.messages[0]?.content).toEqual([]);
  });

  test("a model that reads only words gets the user's wording in place of each picture, in a message and in a tool's result, and its warning still says which model", async () => {
    const seen: SidecarRequest[] = [];
    const provider: SidecarProvider = {
      stream: async function* (req) { seen.push(req); yield { type: "start", model: req.model }; },
      generate: (req) => { seen.push(req); return Promise.resolve({ content: "", content_blocks: [], finish_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 0, time_to_first_token_ms: 0 }, model: req.model }); },
    };
    const warnings: string[] = [];
    const wrapped = withToolImages(provider, { support: () => false, rejected: () => {}, warn: (message) => warnings.push(message) });
    const messages: WireMessage[] = [{ role: "user", content: [{ type: "image", source: gif }, { type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: gif }] }] }];
    await wrapped.generate({ ...request("openai", "words-only", messages, await theirs()), provider_key: "local" });
    expect(seen[0]?.messages[0]?.content).toEqual([
      { type: "text", text: "(no picture: a picture in a message, because local/words-only reads only words)" },
      { type: "tool_result", tool_use_id: "t", is_error: true, content: [{ type: "text", text: "(no picture: a picture from a tool, because local/words-only reads only words)" }] },
    ]);
    expect(warnings).toEqual(["local/words-only does not accept images; 2 image(s) omitted from this request. Original images remain in conversation history."]);
    await wrapped.generate(request("openai", "words-only", messages));
    expect(seen[1]?.messages[0]?.content[0]).toEqual({ type: "text", text: "[image omitted: an attached image — openai/words-only does not accept images]" });
  });
});

describe("pictures a client sends", () => {
  test("one the client named but didn't send, one that isn't a picture and one Shore can't keep are noted in the user's wording", async () => {
    const cache = await mkdtemp(testTmp("image-texts-cache-"));
    const texts = await theirs();
    const { blocks } = await ingestImages(texts, cache, "ada", ["missing.png", "notes.txt"], [{ filename: "notes.txt", data: Buffer.from("just words").toString("base64") }]);
    expect(blocks).toEqual([
      { type: "text", text: "(no picture: notes.txt, because a bare name won't do)" },
      { type: "text", text: "(no picture: missing.png, because it never arrived)" },
    ]);
    const blocked = join(cache, "blocked");
    await writeFile(blocked, "a file where the attachments folder would go");
    const unsaved = await ingestImages(texts, blocked, "ada", [], [{ filename: "dot.gif", data: GIF }]);
    expect(unsaved.blocks).toEqual([{ type: "text", text: "(no picture: dot.gif, because it couldn't be kept)" }]);
  });
});

describe("a tool's picture Shore no longer keeps", () => {
  afterEach(() => { useCharacterTexts(() => new Texts()); });

  test("is told in the character's wording of picture_gone, and in Shore's when the character's texts can't be read", async () => {
    const cache = await mkdtemp(testTmp("image-texts-blobs-"));
    await mkdir(cache, { recursive: true });
    const blobs = imageBlobs(cache, "ada", true);
    const stored = withImageReferences([{ type: "image", source: gif }], blobs);
    const texts = await theirs(["picture_gone"]);
    let asked = 0;
    expect(withImageData([{ type: "text", text: "kept" }], blobs, () => { asked += 1; return texts; })).toEqual([{ type: "text", text: "kept" }]);
    expect(withImageData(stored, blobs, () => { asked += 1; return texts; })).toMatchObject([{ type: "image", source: { type: "base64", data: GIF } }]);
    expect(asked).toBe(0);
    const gone = withImageData(stored, undefined, () => texts) as { type: string; text?: string }[];
    expect(gone.map((block) => block.type)).toEqual(["text"]);
    expect(gone[0]?.text).toMatch(/^\(gone: [0-9a-f]{12}\.gif\)$/);
    useCharacterTexts((character) => character === "ada" ? texts : new Texts({ picture_gone: "nowhere.md" }, cache));
    expect(characterTexts("ada").render("picture_gone", { name: "x.gif" })).toBe("(gone: x.gif)");
    expect(characterTexts("bo").render("picture_gone", { name: "x.gif" })).toBe("[image omitted: x.gif — no longer cached]");
  });
});

test("a request built with texts carries them to its provider, and one built without gets Shore's", async () => {
  const texts = await theirs();
  const { request: built } = buildRequestWithResolvedKey({ sdk: "openai", model_id: "gpt-5", provider_key: "openai" } as Parameters<typeof buildRequestWithResolvedKey>[0], "sk", { texts, messages: [], replay: "all" });
  expect(built.texts).toBe(texts);
  expect(requestTexts(built)).toBe(texts);
  expect(requestTexts({}).wording("image_omitted")).toBe("[image omitted: {{image}} — {{reason}}]");
});
