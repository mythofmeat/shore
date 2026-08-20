import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countImageBlocks,
  imageSupportFor,
  isImageRejection,
  learnedImageSupportPath,
  readLearnedImageSupport,
  recordImageRejection,
  stripImageBlocks,
  textOnlyReason,
} from "../src/llm/image_support";
import type { WireMessage } from "../src/llm/types";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "shore-image-support-"));
}

function imageMessage(): WireMessage {
  return {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "what is this" },
    ],
  };
}

describe("the error signature that means a model refuses images", () => {
  test("the z.ai code shore actually received, direct from the vendor", () => {
    expect(
      isImageRejection({
        kind: "http_status",
        status: 400,
        body: `{"error":{"code":"1210","message":"messages.content.type is invalid, allowed values: ['text']"}}`,
      }),
    ).toBe(true);
  });

  test("the same failure relayed through opencode-go", () => {
    expect(
      isImageRejection(
        new Error(
          "HTTP 400: Error from provider (Console Go): Upstream request failed: " +
            "[1210] messages.content.type is invalid, allowed values: ['text']",
        ),
      ),
    ).toBe(true);
  });

  test("plainer phrasings from other providers", () => {
    expect(isImageRejection(new Error("this model does not support image input"))).toBe(true);
    expect(isImageRejection(new Error("images are not supported by this deployment"))).toBe(true);
  });

  test("an oversized image is not a capability signal", () => {
    expect(
      isImageRejection(new Error("HTTP 400: image exceeds the 5MB limit")),
    ).toBe(false);
  });

  test("a server-side fault is not a capability signal", () => {
    expect(
      isImageRejection({
        kind: "http_status",
        status: 503,
        body: "messages.content.type is invalid",
      }),
    ).toBe(false);
  });

  test("an unrelated failure stays unrelated", () => {
    expect(isImageRejection(new Error("rate limit exceeded"))).toBe(false);
  });
});

describe("what shore remembers after a refusal", () => {
  test("an unknown model stays unknown until something says otherwise", () => {
    const cache = scratch();
    expect(
      imageSupportFor({ providerKey: "opencode-go", modelId: "glm-5.3" }, cache),
    ).toBeUndefined();
  });

  test("a refusal is recorded and read back as text-only", () => {
    const cache = scratch();
    recordImageRejection(cache, "opencode-go", "glm-5.3");
    expect(imageSupportFor({ providerKey: "opencode-go", modelId: "glm-5.3" }, cache)).toBe(false);
  });

  test("the record is scoped to the model that refused", () => {
    const cache = scratch();
    recordImageRejection(cache, "opencode-go", "glm-5.3");
    expect(
      imageSupportFor({ providerKey: "opencode-go", modelId: "kimi-k3" }, cache),
    ).toBeUndefined();
    expect(imageSupportFor({ providerKey: "zai", modelId: "glm-5.3" }, cache)).toBeUndefined();
  });

  test("it lands outside models.json so a discovery refresh cannot wipe it", () => {
    const cache = scratch();
    recordImageRejection(cache, "opencode-go", "glm-5.3");
    const path = learnedImageSupportPath(cache, "opencode-go");
    expect(path.endsWith("image_support.json")).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      models: { "glm-5.3": false },
    });
  });

  test("recording twice keeps one entry", () => {
    const cache = scratch();
    recordImageRejection(cache, "opencode-go", "glm-5.3");
    recordImageRejection(cache, "opencode-go", "glm-5.3");
    expect(readLearnedImageSupport(cache, "opencode-go")).toEqual({ "glm-5.3": false });
  });

  test("a corrupt file reads as no knowledge rather than throwing", async () => {
    const cache = scratch();
    recordImageRejection(cache, "opencode-go", "glm-5.3");
    await Bun.write(learnedImageSupportPath(cache, "opencode-go"), "{not json");
    expect(readLearnedImageSupport(cache, "opencode-go")).toEqual({});
  });
});

describe("which answer wins", () => {
  test("a config declaration beats everything shore learned", () => {
    const cache = scratch();
    recordImageRejection(cache, "opencode-go", "glm-5.3");
    expect(
      imageSupportFor(
        { declared: true, providerKey: "opencode-go", modelId: "glm-5.3" },
        cache,
      ),
    ).toBe(true);
  });

  test("a declaration of false is honored with nothing learned", () => {
    expect(
      imageSupportFor({ declared: false, providerKey: "zai", modelId: "glm-5.3" }, scratch()),
    ).toBe(false);
  });

  test("what the provider published beats what shore learned", () => {
    const cache = scratch();
    recordImageRejection(cache, "openrouter", "z-ai/glm-5v-turbo");
    expect(
      imageSupportFor(
        { discovered: true, providerKey: "openrouter", modelId: "z-ai/glm-5v-turbo" },
        cache,
      ),
    ).toBe(true);
  });
});

describe("dropping images that are already in history", () => {
  test("image blocks become a notice naming the model that cannot read them", () => {
    const reason = textOnlyReason("opencode-go", "glm-5.3");
    const { messages, stripped } = stripImageBlocks([imageMessage()], reason);

    expect(stripped).toBe(1);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "[image omitted: an attached image — opencode-go/glm-5.3 does not accept images]" },
      { type: "text", text: "what is this" },
    ]);
  });

  test("the surrounding turn is left alone", () => {
    const history: WireMessage[] = [
      { role: "user", content: [{ type: "text", text: "before" }] },
      imageMessage(),
      { role: "assistant", content: [{ type: "text", text: "after" }] },
    ];
    const { messages, stripped } = stripImageBlocks(history, "nope");

    expect(stripped).toBe(1);
    expect(messages[0]).toBe(history[0] as WireMessage);
    expect(messages[2]).toBe(history[2] as WireMessage);
  });

  test("history without images is returned untouched", () => {
    const history: WireMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const { messages, stripped } = stripImageBlocks(history, "nope");

    expect(stripped).toBe(0);
    expect(messages[0]).toBe(history[0] as WireMessage);
  });

  test("every image across the whole history is counted", () => {
    expect(countImageBlocks([imageMessage(), imageMessage()])).toBe(2);
    expect(countImageBlocks([{ role: "user", content: [{ type: "text", text: "x" }] }])).toBe(0);
  });
});
