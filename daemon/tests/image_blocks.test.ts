import { describe, expect, test } from "bun:test";

import { translateMessages } from "../src/llm/providers/gemini.ts";
import { turnToOpenAI } from "../src/llm/providers/openai.ts";
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

  test("openrouter: image block → AI SDK image part, before the text", () => {
    const msgs = turnToVercel(
      imageTurn(),
      new Map(),
      "openrouter",
    ) as unknown as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.["content"]).toEqual([
      { type: "image", image: PNG_B64, mediaType: "image/png" },
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
