import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultImagesConfig, type ImagesConfig } from "../src/config/app.ts";
import { estimateMessageTokens } from "../src/engine/prompt.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { encodeImageBlock, ingestImages } from "../src/handler/images.ts";
import { buildLlmMessages } from "../src/handler/wire_messages.ts";
import { findModelCopy, MAX_IMAGE_BYTES } from "../src/llm/images.ts";
import { DEFAULT_IMAGE_SETTINGS, MAX_SENT_IMAGE_BYTES } from "../src/llm/image_settings.ts";
import { HIGH_RESOLUTION_IMAGE_TIER, sizeForTier, STANDARD_IMAGE_TIER, visualTokens } from "../src/llm/image_tokens.ts";
import { DEFAULT_IMAGE_LIMITS, fullResolution, imageLimitsFor } from "../src/llm/prepare_images.ts";
import { toolResultImages, toolResultText } from "../src/llm/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { carryToolMedia } from "../src/tools/media.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";
import { handleRead } from "../src/tools/read.ts";
import { MAX_READ_IMAGE_BYTES } from "../src/tools/read_image.ts";
import { required } from "../src/util/required.ts";
import { sizedImage } from "./support/sized_image.ts";
import { noisePng, withTextChunk } from "./support/test_images.ts";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shore-image-delivery-"));
  roots.push(root);
  return root;
}

function images(read: Partial<ImagesConfig["read"]> = {}, rest: Partial<ImagesConfig> = {}): ImagesConfig {
  const config = defaultImagesConfig();
  return { ...config, ...rest, read: { ...config.read, ...read } };
}

async function world(config: ImagesConfig = defaultImagesConfig()) {
  const root = await tempRoot();
  const workspaceDir = join(root, "workspace");
  await mkdir(workspaceDir);
  const ctx: ToolContext = {
    workspaceDir, characterName: "Ada", characterDataDir: root, imageDir: join(root, "images"), cacheDir: join(root, "cache"),
    conversationDir: root, historyDbPath: join(root, "history.db"), configDir: root,
    images: config,
  };
  const exec: ToolExecution = {
    ctx, sendDirect: () => {}, schemas: BUILTIN_TOOL_SCHEMAS,
    limits: { max_result_chars: 50_000, timeout_ms: 5000 },
    now: () => "2026-09-30", newMessageId: () => crypto.randomUUID(),
  };
  const run = async (name: string, input: unknown) => {
    const result = await runToolUse({ id: crypto.randomUUID(), name, input }, exec, []);
    if (result.block.type !== "tool_result") throw new Error("missing tool result");
    return { ...result, text: toolResultText(result.block.content), images: toolResultImages(result.block.content) };
  };
  const put = async (path: string, content: string | Buffer) => {
    await writeFile(join(workspaceDir, path), content);
    return join(workspaceDir, path);
  };
  return { root, ctx, exec, run, put };
}

async function dimensionsOf(image: ImageBlock | undefined): Promise<{ width: number; height: number }> {
  const { width, height } = await new Bun.Image(Buffer.from(required(image).source.data, "base64")).metadata();
  return { width, height };
}

describe("a workspace image the model reads", () => {
  test("arrives at the read settings, leaves the file alone, and the model is told what it costs", async () => {
    const { run, put } = await world(images({ format: "jpeg", max_tokens: 1600 }));
    const bytes = await sizedImage(4000, 3000);
    const path = await put("ref.png", bytes);
    const result = await run("read", { file_path: "ref.png" });
    expect(result.isError).toBe(false);
    expect(required(result.images[0]).source.media_type).toBe("image/jpeg");
    expect(await dimensionsOf(result.images[0])).toEqual({ width: 1270, height: 952 });
    expect(result.text).toContain(`[${path}: reduced from 4000×3000 PNG (4,740 tokens) to 1270×952 JPEG (1,564 tokens). Read it with original: true for the full image.]`);
    expect((await readFile(path)).toString("base64")).toBe(bytes.toString("base64"));
  });

  test("the costs in the note are the active model's", async () => {
    const { run, put, exec } = await world(images({ max_edge: 1024 }));
    const path = await put("ref.png", await sizedImage(4000, 3000));
    exec.imageLimits = imageLimitsFor("anthropic", "claude-sonnet-4-6");
    expect((await run("read", { file_path: "ref.png" })).text)
      .toContain(`[${path}: reduced from 4000×3000 PNG (1,564 tokens) to 1024×768 PNG (1,036 tokens).`);
    exec.imageLimits = imageLimitsFor("claude_agent", "claude-opus-5-5");
    expect((await run("read", { file_path: "ref.png" })).text)
      .toContain(`[${path}: reduced from 4000×3000 PNG (3,888 tokens) to 1024×768 PNG (1,036 tokens).`);
  });

  test("original: true sends the full resolution the model accepts", async () => {
    const { run, put, exec } = await world(images({ max_edge: 1024 }));
    const path = await put("ref.png", await sizedImage(4000, 3000));
    const full = await run("read", { file_path: "ref.png", original: true });
    expect(full.isError).toBe(false);
    expect(await dimensionsOf(full.images[0])).toEqual({ width: 2212, height: 1659 });
    expect(full.text).toContain(`[${path}: 4000×3000 PNG sent at 2212×1659 PNG (4,740 tokens), the full resolution this model accepts.]`);

    exec.imageLimits = imageLimitsFor("anthropic", "claude-sonnet-4-6");
    const standard = sizeForTier({ width: 4000, height: 3000 }, STANDARD_IMAGE_TIER);
    expect(await dimensionsOf((await run("read", { file_path: "ref.png", original: true })).images[0])).toEqual(standard);

    exec.imageLimits = imageLimitsFor("claude_agent", "claude-opus-5-5");
    const agent = await run("read", { file_path: "ref.png", original: true });
    expect(await dimensionsOf(agent.images[0])).toEqual({ width: 2000, height: 1500 });
    expect(agent.text).toContain("sent at 2000×1500 PNG (3,888 tokens), the full resolution this model accepts.]");
  });

  test("an original goes lossless, larger than the configured max_bytes", async () => {
    const { run, put } = await world(images({ max_edge: 400 }));
    const bytes = await noisePng(900, 700);
    expect(bytes.length).toBeGreaterThan(DEFAULT_IMAGE_SETTINGS.max_bytes);
    await put("scan.png", bytes);
    const full = required((await run("read", { file_path: "scan.png", original: true })).images[0]);
    expect(full.source.media_type).toBe("image/png");
    expect(full.source.data).toBe(bytes.toString("base64"));
  });

  test("an image already inside every limit arrives unchanged, with no note", async () => {
    const { run, put } = await world();
    const bytes = await sizedImage(800, 600);
    await put("small.png", bytes);
    const result = await run("read", { file_path: "small.png" });
    expect(required(result.images[0]).source.data).toBe(bytes.toString("base64"));
    expect(result.text).not.toContain("reduced from");
    expect((await run("read", { file_path: "small.png", original: true })).text).not.toContain("sent at");
  });

  test("an image file over 5 MiB reaches the model the way the same image under 5 MiB does", async () => {
    const { run, put } = await world();
    const image = await sizedImage(3000, 2000);
    const card = withTextChunk(image, 6 * 1024 * 1024);
    expect(card.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    const small = await put("small.png", image);
    const large = await put("card.png", card);
    const note = (text: string, path: string) => text.split("\n").find((line) => line.startsWith(`[${path}: `))?.replace(path, "<path>");
    for (const original of [false, true]) {
      const under = await run("read", { file_path: "small.png", original });
      const over = await run("read", { file_path: "card.png", original });
      expect(over.isError).toBe(false);
      expect(over.text).toContain(`${large}: image/png, 3000×2000, ${String(card.length)} bytes`);
      expect(over.images).toEqual(under.images);
      expect(note(under.text, small)).toContain("3000×2000 PNG");
      expect(note(over.text, large)).toBe(note(under.text, small));
    }
  });

  test("clients are shown an image file up to 5 MiB as it is, and a larger one at the full resolution any model is sent", async () => {
    const { run, put, exec } = await world();
    const frames: ServerMessage[] = [];
    exec.sendDirect = (frame) => { frames.push(frame); };
    const image = await sizedImage(3000, 2000);
    const shown = async (bytes: number) => {
      const file = withTextChunk(image, bytes - image.length - 18);
      expect(file.length).toBe(bytes);
      await put("card.png", file);
      frames.length = 0;
      expect((await run("read", { file_path: "card.png" })).isError).toBe(false);
      const frame = required(frames.find((candidate) => candidate.type === "send_image"));
      const data = required(frame.data);
      expect((await readFile(frame.path)).toString("base64")).toBe(data);
      return { file: file.toString("base64"), data };
    };
    const whole = await shown(MAX_IMAGE_BYTES);
    expect(whole.data).toBe(whole.file);
    const reduced = Buffer.from((await shown(MAX_IMAGE_BYTES + 1)).data, "base64");
    expect(reduced.length).toBeLessThanOrEqual(MAX_SENT_IMAGE_BYTES);
    const { width, height } = await new Bun.Image(reduced).metadata();
    expect({ width, height }).toEqual(required(fullResolution({ width: 3000, height: 2000 }, DEFAULT_IMAGE_LIMITS)));
  });

  test("an image file over the read limit is refused before it is read", async () => {
    const { run, put } = await world();
    const path = await put("huge.png", await sizedImage(40, 30));
    await truncate(path, MAX_READ_IMAGE_BYTES + 1);
    const result = await run("read", { file_path: "huge.png" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${path}: image exceeds the ${String(MAX_READ_IMAGE_BYTES)}-byte input limit`);
  });

  test("an image file over 5 MiB whose pixels cannot be decoded fails the read", async () => {
    const { run, put } = await world();
    const header = (await sizedImage(3000, 2000)).subarray(0, 33);
    const path = await put("broken.png", Buffer.concat([header, Buffer.alloc(MAX_IMAGE_BYTES, 7)]));
    const result = await run("read", { file_path: "broken.png" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${path}: image could not be reduced: `);
    expect(result.images).toHaveLength(0);
  });

  test("tell_model = false sends the reduced image without a note", async () => {
    const { run, put } = await world(images({ max_edge: 1024, tell_model: false }));
    await put("ref.png", await sizedImage(4000, 3000));
    const result = await run("read", { file_path: "ref.png" });
    expect(await dimensionsOf(result.images[0])).toEqual({ width: 1024, height: 768 });
    expect(result.text).not.toContain("reduced from");
  });

  test("allow_original = false offers no original and refuses to send one", async () => {
    const { run, put } = await world(images({ max_edge: 1024, allow_original: false }));
    const path = await put("ref.png", await sizedImage(4000, 3000));
    const result = await run("read", { file_path: "ref.png" });
    expect(result.text).toContain(`[${path}: reduced from 4000×3000 PNG (4,740 tokens) to 1024×768 PNG (1,036 tokens).]`);
    const refused = await run("read", { file_path: "ref.png", original: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("original is turned off by images.read.allow_original");
    expect(refused.images).toHaveLength(0);
  });

  test("original must be true or false", async () => {
    const { ctx, put } = await world();
    await put("ref.png", await sizedImage(40, 30));
    expect(await handleRead({ file_path: "ref.png", original: "yes" }, ctx.workspaceDir).then(() => "read", (e: unknown) => String(e)))
      .toContain("original must be true or false");
  });

  test("original applies only to image files", async () => {
    const { run, put } = await world();
    await put("notes.md", "plain text\n");
    const result = await run("read", { file_path: "notes.md", original: true });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("original applies only to image files");
  });

  test("an image in Markdown is reduced the same way, and the note names the file to read in full", async () => {
    const { run, put } = await world(images({ max_edge: 1024 }));
    const sheet = await put("sheet.png", await sizedImage(3000, 2000));
    await put("character.md", "# Ada\n\n![Reference sheet](sheet.png)\n");
    const result = await run("read", { file_path: "character.md" });
    expect(await dimensionsOf(result.images[0])).toEqual({ width: 1024, height: 683 });
    expect(result.text).toContain(`[Reference sheet (${sheet}): reduced from 3000×2000 PNG (`);
    expect(result.text).toContain(`Read ${sheet} with original: true for the full image.]`);
  });

  test("an image over 5 MiB in Markdown is attached the same way", async () => {
    const { run, put } = await world(images({ max_edge: 1024 }));
    const card = await put("card.png", withTextChunk(await sizedImage(3000, 2000), 6 * 1024 * 1024));
    await put("character.md", "# Ada\n\n![Card](card.png)\n");
    const result = await run("read", { file_path: "character.md" });
    expect(await dimensionsOf(result.images[0])).toEqual({ width: 1024, height: 683 });
    expect(result.text).toContain(`[Card (${card}): reduced from 3000×2000 PNG (`);
  });

  test("Markdown images are budgeted at the size the read settings send", async () => {
    const { run, put, exec } = await world(images({ max_bytes: 100_000 }));
    for (const [index, name] of ["a", "b", "c"].entries()) {
      const bytes = await noisePng(300, 200, index + 1);
      expect(bytes.length).toBeGreaterThan(150_000);
      await put(`${name}.png`, bytes);
    }
    await put("gallery.md", "![a](a.png) ![b](b.png) ![c](c.png)\n");
    exec.limits = { ...exec.limits, max_inline_image_bytes: 350_000 };
    const result = await run("read", { file_path: "gallery.md" });
    expect(result.images).toHaveLength(3);
    for (const image of result.images) expect(Buffer.from(image.source.data, "base64").length).toBeLessThanOrEqual(100_000);
    exec.limits = { ...exec.limits, max_inline_image_bytes: 250_000 };
    const bounded = await run("read", { file_path: "gallery.md" });
    expect(bounded.images).toHaveLength(2);
    expect(bounded.text).toContain("[Markdown image(s) c.png not read: they would not fit the 250000-byte inline image budget");
  });
});

describe("an image in an MCP tool result", () => {
  test("is reduced at the MCP settings without telling the model", async () => {
    const { run, ctx, exec } = await world(images({}, { mcp: { ...defaultImagesConfig().mcp, max_edge: 512 } }));
    const data = (await sizedImage(2048, 1536)).toString("base64");
    ctx.mcpCall = () => Promise.resolve(carryToolMedia({ value: "a screenshot", media: [{ mime_type: "image/png", data, label: "image/png, screenshot" }], extra: [] }));
    delete exec.schemas;
    const result = await run("mcp__browser__screenshot", {});
    expect(result.isError).toBe(false);
    expect(await dimensionsOf(result.images[0])).toEqual({ width: 512, height: 384 });
    expect(result.text).not.toContain("reduced");
    expect(result.text).not.toContain("original");
  });
});

describe("an image a user sends", () => {
  const upload = async (settings = DEFAULT_IMAGE_SETTINGS, bytes?: Buffer) => {
    const dataDir = await tempRoot();
    const original = bytes ?? await sizedImage(4000, 3000);
    const ingested = await ingestImages(dataDir, "ada", ["photo.png"], [{ filename: "photo.png", data: original.toString("base64") }], new Date("2026-09-30T10:00:00Z"), settings);
    return { dataDir, original, ingested, ref: required(ingested.images[0]) };
  };

  test("is reduced once, when it arrives, and the original is kept as sent", async () => {
    const { original, ingested, ref } = await upload({ ...DEFAULT_IMAGE_SETTINGS, max_edge: 1024, format: "jpeg" });
    expect(ingested.blocks).toEqual([]);
    expect((await readFile(ref.path)).toString("base64")).toBe(original.toString("base64"));
    const copy = required(findModelCopy(ref.path));
    expect(copy.mediaType).toBe("image/jpeg");
    const sent = required(await encodeImageBlock(ref));
    expect(sent.media_type).toBe("image/jpeg");
    expect(sent.data).toBe((await readFile(copy.path)).toString("base64"));
    expect(await dimensionsOf({ type: "image", source: sent })).toEqual({ width: 1024, height: 768 });
  });

  test("reaches the model at that size with no note that it was reduced", async () => {
    const { ref } = await upload({ ...DEFAULT_IMAGE_SETTINGS, max_tokens: 1000 });
    const { messages } = await buildLlmMessages({
      system: [],
      messages: [{ role: "user", content: "what is this?", images: [ref], content_blocks: [{ type: "text", text: "what is this?" }] }],
    }, "text_standin");
    const content = required(messages[0]).content;
    expect(content.map((block) => block.type)).toEqual(["image", "text"]);
    expect(await dimensionsOf(content[0] as ImageBlock)).toEqual({ width: 1008, height: 756 });
    expect(JSON.stringify(content)).not.toContain("reduced");
  });

  test("is counted in the context at the size of its reduced copy", async () => {
    const { ref } = await upload({ ...DEFAULT_IMAGE_SETTINGS, max_tokens: 1000 });
    const message: Message = { msg_id: "m", role: "user", content: "", images: [ref], content_blocks: [], timestamp: "2026-09-30T10:00:00Z" };
    expect(estimateMessageTokens(message, HIGH_RESOLUTION_IMAGE_TIER)).toBe(visualTokens(1008, 756));
  });

  test("an attachment saved before reduction on arrival is prepared the way it always was", async () => {
    const dataDir = await tempRoot();
    const path = join(dataDir, "attachments", "20260101_000000_old.png");
    await mkdir(join(dataDir, "attachments"), { recursive: true });
    await writeFile(path, await sizedImage(4000, 1000));
    const sent = required(await encodeImageBlock({ path }));
    expect(sent.media_type).toBe("image/png");
    expect(await dimensionsOf({ type: "image", source: sent })).toEqual({ width: 2000, height: 500 });
    const message: Message = { msg_id: "m", role: "user", content: "", images: [{ path }], content_blocks: [], timestamp: "2026-09-30T10:00:00Z" };
    expect(estimateMessageTokens(message, HIGH_RESOLUTION_IMAGE_TIER)).toBe(visualTokens(2000, 500));
  });

  test("an upload the settings cannot reduce is still sent the way older attachments are", async () => {
    const { ref } = await upload({ ...DEFAULT_IMAGE_SETTINGS, max_bytes: 1 });
    expect(findModelCopy(ref.path)).toBeUndefined();
    const sent = required(await encodeImageBlock(ref));
    expect(await dimensionsOf({ type: "image", source: sent })).toEqual({ width: 2000, height: 1500 });
  });
});
