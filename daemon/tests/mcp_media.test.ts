import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { interpretResult } from "../src/mcp/client.ts";
import { carryToolMedia, toolMediaOf } from "../src/tools/media.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import type { ToolContext, ToolLimitsView } from "../src/tools/dispatch.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { runnableTools } from "../src/llm/providers/anthropic_tools.ts";
import { turnToOpenAI } from "../src/llm/providers/openai.ts";
import { turnToVercel } from "../src/llm/providers/vercel.ts";
import { translateMessages } from "../src/llm/providers/gemini.ts";
import { countImageBlocks, stripImageBlocks } from "../src/llm/image_support.ts";
import { buildLlmMessages } from "../src/handler/wire_messages.ts";
import { normalizeMessage } from "../src/engine/message_store.ts";
import { oversizedImage } from "./support/oversized_image.ts";
import { toolImageCacheDir } from "../src/storage/image_cache.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const LIMITS: ToolLimitsView = { max_result_chars: 0, timeout_ms: 0 };

function imageResult(count: number, data = PNG): Record<string, unknown> {
  return {
    content: Array.from({ length: count }, () => ({
      type: "image",
      data,
      mimeType: "image/png",
    })),
  };
}

async function runMcpTool(
  raw: Record<string, unknown>,
  limits: ToolLimitsView = LIMITS,
  notes: string[] = [],
): Promise<{ block: ContentBlock; frames: ServerMessage[]; saved: string[] }> {
  const cacheDir = await mkdtemp(join(tmpdir(), "shore-mcp-media-"));
  const frames: ServerMessage[] = [];
  const ctx: ToolContext = {
    imageDir: "",
    cacheDir,
    workspaceDir: "",
    characterDataDir: "",
    conversationDir: "",
  historyDbPath: "/tmp/history.db",
  characterName: "ada",
    configDir: "",
    retrievalConfig: {
      maxFileBytes: 0,
      maxIndexedFiles: 0,
      maxTotalIndexedBytes: 0,
      maxEmbedCharsPerFile: 0,
      binary: "skip",
    },
    retrievalMode: "auto",
    mcpCall: () => Promise.resolve(carryToolMedia({ ...interpretResult(raw), notes })),
  };
  const exec: ToolExecution = {
    sendDirect: (m) => frames.push(m),
    ctx,
    limits,
    now: () => "2026-01-01T00:00:00-05:00",
    newMessageId: () => "m_test",
    monotonicMs: () => 0,
  };

  const run = await runToolUse({ id: "toolu_1", name: "mcp__srv__shot", input: {} }, exec, []);
  let saved: string[] = [];
  try {
    saved = (await readdir(toolImageCacheDir(cacheDir, "ada"))).sort();
  } catch {
    saved = [];
  }
  await rm(cacheDir, { recursive: true, force: true });
  return { block: run.block, frames, saved };
}

function toolResult(block: ContentBlock): Extract<ContentBlock, { type: "tool_result" }> {
  if (block.type !== "tool_result") throw new Error(`expected a tool_result, got ${block.type}`);
  return block;
}

function blocksOf(block: ContentBlock): ContentBlock[] {
  const content = toolResult(block).content;
  if (typeof content === "string") throw new Error(`expected content blocks, got ${content}`);
  return content;
}

function textOf(block: ContentBlock): string {
  const content = toolResult(block).content;
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

describe("mcp media reaches the model", () => {
  test("an image-only result is an image block, never an empty success", async () => {
    const { block, frames, saved } = await runMcpTool(imageResult(1));

    const images = blocksOf(block).filter((b) => b.type === "image");
    expect(images).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ]);
    expect(textOf(block)).toContain("image/png");
    expect(textOf(block)).not.toBe("");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEndWith(".png");
    expect(frames.filter((f) => f.type === "send_image")).toHaveLength(1);
  });

  test("text alongside an image keeps both", async () => {
    const { block } = await runMcpTool({
      content: [
        { type: "text", text: "here is the screenshot" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    });

    expect(textOf(block)).toStartWith("here is the screenshot");
    expect(blocksOf(block).filter((b) => b.type === "image")).toHaveLength(1);
  });

  test("audio is described rather than delivered as an empty string", async () => {
    const { block, saved } = await runMcpTool({
      content: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }],
    });

    expect(toolResult(block).content).toContain("audio omitted");
    expect(toolResult(block).content).toContain("audio/wav");
    expect(saved).toEqual([]);
  });

  test("ten small images are sent with the default budget", async () => {
    const { block, saved } = await runMcpTool(imageResult(10));

    expect(blocksOf(block).filter((b) => b.type === "image")).toHaveLength(10);
    expect(toolResult(block).is_error).toBe(false);
    expect(saved).toHaveLength(10);
  });

  test("the byte budget allows an exact fit and notes skipped images without failing", async () => {
    const bytes = Buffer.from(PNG, "base64").length;
    const { block, saved, frames } = await runMcpTool(imageResult(3), { ...LIMITS, max_inline_image_bytes: 2 * bytes });

    expect(blocksOf(block).filter((b) => b.type === "image")).toHaveLength(2);
    expect(toolResult(block).is_error).toBe(false);
    expect(textOf(block)).toContain(`not sent to the model: at most 20 images and ${2 * bytes} bytes`);
    expect(saved).toHaveLength(3);
    expect(frames.filter((frame) => frame.type === "send_image")).toHaveLength(3);
    const result = frames.find((frame) => frame.type === "tool_result");
    expect(result?.images).toHaveLength(3);
    expect(result?.images?.[2]?.data).toBe(PNG);
  });

  test("at most twenty images are sent, and one note names the rest", async () => {
    const { block, saved } = await runMcpTool(imageResult(25));

    expect(blocksOf(block).filter((b) => b.type === "image")).toHaveLength(20);
    expect(toolResult(block).is_error).toBe(false);
    expect(textOf(block).match(/not sent to the model/g)).toHaveLength(1);
    expect(textOf(block)).toContain(" and 2 more not sent to the model");
    expect(saved).toHaveLength(25);
  });

  test("the budget counts prepared bytes, so large screenshots are resized to fit", async () => {
    const large = (await oversizedImage()).source.data;
    const { block } = await runMcpTool(imageResult(2, large));

    const images = blocksOf(block).filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    expect(toolResult(block).is_error).toBe(false);
    for (const image of images) expect(image.type === "image" && image.source.data.length).toBeLessThanOrEqual(1_000_000);
  });

  test("per-tool budgets override the global and zero disables inline images", async () => {
    const bytes = Buffer.from(PNG, "base64").length;
    const limits = { ...LIMITS, max_inline_image_bytes: bytes, config: { mcp__srv__shot: { max_inline_image_bytes: 3 * bytes } } };
    const { block } = await runMcpTool(imageResult(3), limits);
    expect(blocksOf(block).filter((b) => b.type === "image")).toHaveLength(3);
    limits.config.mcp__srv__shot.max_inline_image_bytes = 0;
    const disabled = await runMcpTool(imageResult(1), limits);
    expect(typeof toolResult(disabled.block).content).toBe("string");
    expect(toolResult(disabled.block).is_error).toBe(false);
    expect(textOf(disabled.block)).toContain("not sent to the model: inline images are disabled for this tool");
  });

  test("an image that does not fit leaves room for later smaller images", async () => {
    const png = Buffer.from(PNG, "base64");
    const larger = Buffer.concat([png, Buffer.alloc(1)]).toString("base64");
    const { block, frames } = await runMcpTool({ content: [PNG, larger, PNG].map((data) => ({ type: "image", data, mimeType: "image/png" })) },
      { ...LIMITS, max_inline_image_bytes: 2 * png.length });
    expect(blocksOf(block).filter((b) => b.type === "image")).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ]);
    expect(toolResult(block).is_error).toBe(false);
    expect(textOf(block)).toContain("not sent to the model");
    expect(frames.find((frame) => frame.type === "tool_result")?.images?.[1]?.data).toBe(larger);
  });

  test("a tool's media notes follow the windowed output instead of being truncated", async () => {
    const { block } = await runMcpTool({ content: [{ type: "text", text: "x".repeat(2000) }] }, { ...LIMITS, max_result_chars: 100 }, ["[kept note]"]);

    expect(textOf(block)).toContain("tool_result truncated");
    expect(textOf(block)).toEndWith("[kept note]");
  });

  test("an oversized invalid image returns an explicit preparation error", async () => {
    const oversized = "A".repeat(1_400_004);
    const { block, saved, frames } = await runMcpTool(imageResult(1, oversized));

    expect(toolResult(block).content).toContain("not sent to the model");
    expect(typeof toolResult(block).content).toBe("string");
    expect(saved).toHaveLength(1);
    expect(frames.find((frame) => frame.type === "tool_result")?.images?.[0]?.data).toBe(oversized);
  });

  test("an unreadable image directory degrades to a note, not a thrown tool", async () => {
    const frames: ServerMessage[] = [];
    const ctx: ToolContext = {
      imageDir: "",
      cacheDir: "/proc/shore-cannot-write-here",
      workspaceDir: "",
      characterDataDir: "",
      conversationDir: "",
  historyDbPath: "/tmp/history.db",
  characterName: "",
      configDir: "",
      retrievalConfig: {
        maxFileBytes: 0,
        maxIndexedFiles: 0,
        maxTotalIndexedBytes: 0,
        maxEmbedCharsPerFile: 0,
        binary: "skip",
      },
      retrievalMode: "auto",
      mcpCall: () => Promise.resolve(carryToolMedia(interpretResult(imageResult(1)))),
    };
    const run = await runToolUse(
      { id: "toolu_1", name: "mcp__srv__shot", input: {} },
      {
        sendDirect: (m) => frames.push(m),
        ctx,
        limits: LIMITS,
        now: () => "2026-01-01T00:00:00-05:00",
        newMessageId: () => "m_test",
        monotonicMs: () => 0,
      },
      [],
    );

    expect(run.isError).toBe(false);
    expect(textOf(run.block)).toContain("could not be saved");
    expect(frames.filter((f) => f.type === "send_image")).toHaveLength(0);
  });

  test("a text-only result still carries a plain string, with no media wrapper", async () => {
    const { block, saved } = await runMcpTool({ content: [{ type: "text", text: "plain" }] });

    expect(toolResult(block).content).toBe("plain");
    expect(saved).toEqual([]);
    expect(toolMediaOf(carryToolMedia({ value: "plain", media: [], extra: [] }))).toBeUndefined();
  });

  test("structured content is not repeated by its own mirrored text", async () => {
    const { block } = await runMcpTool({
      structuredContent: { ok: true },
      content: [{ type: "text", text: '{"ok":true}' }],
    });

    expect(toolResult(block).content).toBe('{"ok":true}');
  });
});

const IMAGE_TOOL_RESULT: ContentBlock = {
  type: "tool_result",
  tool_use_id: "toolu_1",
  content: [
    { type: "text", text: "the screenshot" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
  ],
};

describe("providers deliver tool result images", () => {
  test("openai lifts the image into the user turn that follows the tool message", () => {
    const out = turnToOpenAI({ role: "user", content: [IMAGE_TOOL_RESULT] });

    expect(out[0]).toEqual({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "the screenshot",
    });
    expect(out[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Images from tool result (tool_call_id: toolu_1):" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }],
    });
  });

  test("vercel lifts the image into the user turn that follows the tool message", () => {
    const out = turnToVercel(
      { role: "user", content: [IMAGE_TOOL_RESULT] },
      new Map([["toolu_1", "shot"]]),
    );

    expect(out[0]?.role).toBe("tool");
    expect(out[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Images from tool shot (tool_call_id: toolu_1):" }, { type: "image", image: PNG, mediaType: "image/png" }],
    });
  });

  test("gemini sends inline data beside a text function response", () => {
    const parts = translateMessages([{ role: "user", content: [IMAGE_TOOL_RESULT] }])[0]?.parts;

    expect(parts?.[0]).toEqual({
      functionResponse: { id: "toolu_1", name: "toolu_1", response: { result: "the screenshot" } },
    });
    expect(parts?.[1]).toEqual({ text: "Image from tool toolu_1 (tool_call_id: toolu_1):" });
    expect(parts?.[2]).toEqual({ inlineData: { mimeType: "image/png", data: PNG } });
  });
});

describe("the anthropic tool runner returns content blocks", () => {
  test("an image tool result becomes text plus an image param", async () => {
    const phase = {
      messages: [],
      runTool: () => Promise.resolve(IMAGE_TOOL_RESULT),
      recordTurn: () => undefined,
    };
    const [tool] = runnableTools(
      [{ name: "mcp__srv__shot", description: "", input_schema: { type: "object" } }],
      phase,
      () => undefined,
    );

    expect(await tool?.run({}, { toolUse: { id: "toolu_1" } } as never)).toEqual([
      { type: "text", text: "the screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ]);
  });

  test("a plain string result is still returned as a string", async () => {
    const phase = {
      messages: [],
      runTool: () =>
        Promise.resolve({
          type: "tool_result" as const,
          tool_use_id: "toolu_1",
          content: "plain",
        }),
      recordTurn: () => undefined,
    };
    const [tool] = runnableTools(
      [{ name: "mcp__srv__shot", description: "", input_schema: { type: "object" } }],
      phase,
      () => undefined,
    );

    expect(await tool?.run({}, { toolUse: { id: "toolu_1" } } as never)).toBe("plain");
  });
});

describe("a stored tool result image survives the next turn", () => {
  test("assembly replays the nested image, and does not dump it into content", async () => {
    const stored = normalizeMessage({
      msg_id: "m_1",
      role: "user",
      content: "",
      images: [],
      content_blocks: [IMAGE_TOOL_RESULT],
      timestamp: "2026-01-01T00:00:00-05:00",
    });

    expect(stored.content).toBe("the screenshot");

    const { messages } = await buildLlmMessages(
      { system: [], messages: [{ ...stored, images: [] }] },
      "tool_pair",
    );

    expect(messages[0]?.content).toEqual([IMAGE_TOOL_RESULT]);
  });
});

describe("text-only models drop tool result images explicitly", () => {
  test("a nested image is counted and stripped with a notice", () => {
    const messages = [{ role: "user" as const, content: [IMAGE_TOOL_RESULT] }];
    expect(countImageBlocks(messages)).toBe(1);

    const outcome = stripImageBlocks(messages, "kimi/k3 does not accept images");
    expect(outcome.stripped).toBe(1);

    const content = outcome.messages[0]?.content[0];
    expect(content?.type).toBe("tool_result");
    const nested = content?.type === "tool_result" ? content.content : [];
    expect(nested).toEqual([
      { type: "text", text: "the screenshot" },
      {
        type: "text",
        text: "[image omitted: a tool result image — kimi/k3 does not accept images]",
      },
    ]);
  });
});
