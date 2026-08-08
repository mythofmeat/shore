import { basename } from "node:path";

import type { ImageRef, ContentBlock } from "../engine/types.ts";
import type { AssembledPrompt, PromptMessage } from "../engine/prompt.ts";
import type { Sdk, SystemBlock, WireMessage } from "../llm/types.ts";
import { buildContent, encodeImageBlock, type CachedResize } from "./images.ts";

export type AssistantImageMode = "tool_pair" | "text_standin";

export function assistantImageModeForRequest(sdk: Sdk, hasToolDefs: boolean): AssistantImageMode {
  return sdk === "anthropic" && hasToolDefs ? "tool_pair" : "text_standin";
}

interface AssistantImageRender {
  assistantBlocks: ContentBlock[];
  toolResults: ContentBlock[];
}

function syntheticToolUseId(path: string, index: number): string {
  const stem = fileStem(path) ?? "image";
  const safe = [...stem]
    .map((c) => (/[0-9A-Za-z]/.test(c) ? c : "_"))
    .slice(0, 48)
    .join("");
  return `toolu_gen_${index}_${safe}`;
}

function fileStem(path: string): string | undefined {
  const name = basename(path);
  if (name === "" || name === "." || name === "..") return undefined;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function usableCaption(img: ImageRef): string | undefined {
  const caption = img.caption?.trim();
  return caption === undefined || caption === "" ? undefined : caption;
}

async function renderAssistantImages(
  images: readonly ImageRef[],
  mode: AssistantImageMode,
  maxImageSize: number,
  cacheDir: string,
  resize: CachedResize | undefined,
): Promise<AssistantImageRender> {
  const render: AssistantImageRender = { assistantBlocks: [], toolResults: [] };

  for (const [index, img] of images.entries()) {
    const source =
      mode === "tool_pair"
        ? await encodeImageBlock(img, maxImageSize, cacheDir, resize)
        : undefined;
    const caption = usableCaption(img);

    if (source === undefined) {
      render.assistantBlocks.push({
        type: "text",
        text: caption === undefined ? "[sent an image]" : `[sent an image: ${caption}]`,
      });
      continue;
    }

    const id = syntheticToolUseId(img.path, index);
    render.assistantBlocks.push({
      type: "tool_use",
      id,
      name: "generate_image",
      input: caption === undefined ? {} : { caption },
    });
    const content: ContentBlock[] = [{ type: "image", source }];
    if (caption !== undefined) content.push({ type: "text", text: caption });
    render.toolResults.push({ type: "tool_result", tool_use_id: id, content });
  }

  return render;
}

async function renderMessageContent(
  m: PromptMessage,
  maxImageSize: number,
  cacheDir: string,
  mode: AssistantImageMode,
  resize: CachedResize | undefined,
): Promise<{ content: ContentBlock[]; owedToolResults: ContentBlock[] } | undefined> {
  const reroute = m.role === "assistant" && m.images.length > 0;
  const imageRender = reroute
    ? await renderAssistantImages(m.images, mode, maxImageSize, cacheDir, resize)
    : undefined;
  const turnImages = reroute ? [] : m.images;

  const fallback = () => buildContent(m.content, turnImages, maxImageSize, cacheDir, resize);

  let content: ContentBlock[];
  if (m.content_blocks.length === 0) {
    content = await fallback();
  } else {
    const blocks: ContentBlock[] = [];
    for (const img of turnImages) {
      const source = await encodeImageBlock(img, maxImageSize, cacheDir, resize);
      if (source !== undefined) blocks.push({ type: "image", source });
    }
    blocks.push(...m.content_blocks.filter((b) => !(b.type === "text" && b.text.trim() === "")));

    content = blocks.length === 0 ? await fallback() : blocks;
  }

  if (imageRender !== undefined) content = [...content, ...imageRender.assistantBlocks];
  if (content.length === 0) return undefined;

  return { content, owedToolResults: imageRender?.toolResults ?? [] };
}

export async function buildLlmMessages(
  prompt: AssembledPrompt,
  maxImageSize: number,
  cacheDir: string,
  mode: AssistantImageMode,
  resize?: CachedResize,
): Promise<{ messages: WireMessage[]; system: SystemBlock[] }> {
  const messages: WireMessage[] = [];
  let pending: ContentBlock[] = [];

  for (const m of prompt.messages) {
    const rendered = await renderMessageContent(m, maxImageSize, cacheDir, mode, resize);
    if (rendered === undefined) {
      continue;
    }

    let content = rendered.content;
    if (pending.length > 0) {
      const owed = pending;
      pending = [];
      if (m.role === "user") {
        content = [...owed, ...content];
      } else {
        messages.push({ role: "user", content: owed });
      }
    }

    messages.push({
      role: m.role,
      content,
      ...(m.provider_key === undefined ? {} : { provider_key: m.provider_key }),
      ...(m.model === undefined ? {} : { model: m.model }),
    });
    pending.push(...rendered.owedToolResults);
  }

  if (pending.length > 0) messages.push({ role: "user", content: pending });

  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label }));

  return { messages, system };
}
