import { describe, expect, test } from "bun:test";

import { translateMessages } from "../src/llm/providers/gemini.ts";
import { turnToOpenAI } from "../src/llm/providers/openai.ts";
import { turnToOpenRouter } from "../src/llm/providers/openrouter.ts";
import { turnToVercel } from "../src/llm/providers/vercel.ts";
import { buildZaiMessages } from "../src/llm/providers/zai.ts";
import type { SidecarRequest, TurnMessage } from "../src/llm/types.ts";

const PNG_B64 = "iVBORw0KGgo=";

function imageTurn(): TurnMessage {
  return {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
      { type: "text", text: "what is this?" },
    ],
  };
}

const DATA_URL = `data:image/png;base64,${PNG_B64}`;

describe("inlined image blocks reach the wire", () => {
  test("openai: image block → image_url part, before the text", () => {
    const msgs = turnToOpenAI(imageTurn()) as unknown as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.["role"]).toBe("user");
    expect(msgs[0]?.["content"]).toEqual([
      { type: "image_url", image_url: { url: DATA_URL } },
      { type: "text", text: "what is this?" },
    ]);
  });

  test("openrouter: image block → image_url part, before the text", () => {
    const msgs = turnToOpenRouter(imageTurn()) as unknown as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.["content"]).toEqual([
      { type: "image_url", imageUrl: { url: DATA_URL } },
      { type: "text", text: "what is this?" },
    ]);
  });

  test("vercel: image block → AI SDK image part, before the text", () => {
    const msgs = turnToVercel(imageTurn(), new Map()) as unknown as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.["content"]).toEqual([
      { type: "image", image: PNG_B64, mediaType: "image/png" },
      { type: "text", text: "what is this?" },
    ]);
  });

  test("gemini: image block → inlineData part, before the text", () => {
    const contents = translateMessages([imageTurn()]);
    expect(contents).toHaveLength(1);
    expect(contents[0]?.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: PNG_B64 } },
      { text: "what is this?" },
    ]);
  });

  test("zai: inherits the OpenAI conversion, image survives", () => {
    const req = {
      model: "glm-4.6",
      messages: [imageTurn()],
      provider_options: {},
    } as unknown as SidecarRequest;
    const msgs = buildZaiMessages(req) as unknown as Array<Record<string, unknown>>;
    const user = msgs.find((m) => m["role"] === "user");
    expect(user?.["content"]).toEqual([
      { type: "image_url", image_url: { url: DATA_URL } },
      { type: "text", text: "what is this?" },
    ]);
  });
});

describe("an image that cannot travel is declared, not dropped in silence", () => {
  test("an unsupported media type becomes a note the model can read", () => {
    const turn = {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/tiff", data: PNG_B64 } },
        { type: "text", text: "still here" },
      ],
    } as TurnMessage;
    const msgs = turnToOpenAI(turn) as unknown as Array<Record<string, unknown>>;
    const parts = msgs[0]?.["content"] as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]?.text).toContain("image omitted");
    expect(parts[0]?.text).toContain("image/tiff");
    expect(parts[1]).toEqual({ type: "text", text: "still here" });
  });

  test("an oversized image says so, and says how big it was", () => {
    const huge = "A".repeat(8 * 1024 * 1024);
    const turn = {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: huge } },
        { type: "text", text: "still here" },
      ],
    } as TurnMessage;
    const msgs = turnToOpenAI(turn) as unknown as Array<Record<string, unknown>>;
    const parts = msgs[0]?.["content"] as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]?.text).toContain("over the 5242880-byte limit");
    expect(parts[1]).toEqual({ type: "text", text: "still here" });
  });
});

describe("tool_result turns are unaffected", () => {
  test("openai: image block alongside a tool_result keeps both messages", () => {
    const turn = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "ok" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
      ],
    } as TurnMessage;
    const msgs = turnToOpenAI(turn) as unknown as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.["role"]).toBe("tool");
    expect(msgs[1]?.["content"]).toEqual([{ type: "image_url", image_url: { url: DATA_URL } }]);
  });
});
