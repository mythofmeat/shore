import { existsSync } from "node:fs";
import { basename } from "node:path";

import type { ImageRef, ContentBlock, MessageNote } from "../engine/types.ts";
import { isToolResultOnly } from "../engine/message_store.ts";
import type { AssembledPrompt, PromptMessage, PromptSource } from "../engine/prompt.ts";
import { imageLabel } from "../llm/images.ts";
import type { Sdk, SystemBlock, WireMessage } from "../llm/types.ts";
import { encodeImageBlock } from "./images.ts";
import type { Texts } from "../texts/texts.ts";

export type AssistantImageMode = "tool_pair" | "text_standin";

export interface SentMessage {
  msg_id: string;
  notes: MessageNote[];
}

const NOTE_ORDER: readonly MessageNote["place"][] = ["before", "start", "instead", "end", "after"];

export function inReadingOrder(notes: readonly MessageNote[]): MessageNote[] {
  return [...notes].sort((a, b) => NOTE_ORDER.indexOf(a.place) - NOTE_ORDER.indexOf(b.place));
}

function textsOf(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((block) => block.type === "text" ? [block.text] : []);
}

const TOOL_PAIR_SDKS: readonly Sdk[] = ["anthropic", "claude_agent"];

export function assistantImageModeForRequest(sdk: Sdk, hasToolDefs: boolean): AssistantImageMode {
  return TOOL_PAIR_SDKS.includes(sdk) && hasToolDefs ? "tool_pair" : "text_standin";
}

interface AssistantImageRender {
  assistantBlocks: ContentBlock[];
  toolResults: ContentBlock[];
}

function syntheticToolUseId(path: string, index: number): string {
  const stem = fileStem(path) ?? "image";
  const safe = Array.from(stem, (c) => (/[0-9A-Za-z]/.test(c) ? c : "_"))
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
  texts: Texts,
): Promise<AssistantImageRender> {
  const render: AssistantImageRender = { assistantBlocks: [], toolResults: [] };

  for (const [index, img] of images.entries()) {
    const source =
      mode === "tool_pair"
        ? await encodeImageBlock(img)
        : undefined;
    const caption = usableCaption(img);

    if (source === undefined) {
      render.assistantBlocks.push({
        type: "text",
        text: texts.always("sent_picture", { caption }),
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
  mode: AssistantImageMode,
  texts: Texts,
): Promise<{ content: ContentBlock[]; owedToolResults: ContentBlock[] } | undefined> {
  const images = m.images.filter((image) => image.embed === undefined);
  const reroute = m.role === "assistant";
  const imageRender = reroute ? await renderAssistantImages(images, mode, texts) : undefined;
  const turnImages = reroute || isToolResultOnly(m) ? [] : images;

  let content: ContentBlock[] = [];
  for (const img of turnImages) {
    const source = await encodeImageBlock(img, true);
    const kept = existsSync(img.path);
    const label = source !== undefined && kept ? texts.render("picture", { path: img.path }) : undefined;
    if (label !== undefined) content.push({ type: "text", text: label });
    if (source !== undefined) content.push({ type: "image", source });
    else if (!kept) content.push({ type: "text", text: texts.always("picture_gone", { name: imageLabel(img) }) });
  }
  content.push(...m.content_blocks.filter((block) => !(block.type === "text" && block.text.trim() === "")));

  if (imageRender !== undefined) content = [...content, ...imageRender.assistantBlocks];
  if (content.length === 0) return undefined;

  return { content, owedToolResults: imageRender?.toolResults ?? [] };
}

export async function buildLlmMessages(
  prompt: Pick<AssembledPrompt, "system" | "messages"> & { sources?: readonly PromptSource[] },
  mode: AssistantImageMode,
  texts: Texts,
): Promise<{ messages: WireMessage[]; system: SystemBlock[]; sent: SentMessage[] }> {
  const messages: WireMessage[] = [];
  const sent: SentMessage[] = [];
  let pending: ContentBlock[] = [];
  let added: string[] = [];

  for (const [index, m] of prompt.messages.entries()) {
    const rendered = await renderMessageContent(m, mode, texts);
    if (rendered === undefined) {
      continue;
    }
    const source = prompt.sources?.[index];
    if (source?.msg_id === undefined) added.push(...textsOf(rendered.content));
    else {
      const own = new Set(m.content_blocks);
      const place = m.role === "assistant" ? "end" : "start";
      sent.push({
        msg_id: source.msg_id,
        notes: inReadingOrder([
          ...added.map((text): MessageNote => ({ place: "before", text })),
          ...textsOf(rendered.content.filter((block) => !own.has(block))).map((text): MessageNote => ({ place, text })),
          ...source.notes,
        ]),
      });
      added = [];
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
  sent.at(-1)?.notes.push(...added.map((text): MessageNote => ({ place: "after", text })));

  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label }));

  return { messages, system, sent };
}
