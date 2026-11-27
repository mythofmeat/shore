import { existsSync } from "node:fs";

import type { ImageRef, ContentBlock, MessageNote } from "../engine/types.ts";
import { isToolResultOnly } from "../engine/message_store.ts";
import type { AssembledPrompt, PromptMessage, PromptSource } from "../engine/prompt.ts";
import { imageLabel } from "../llm/images.ts";
import type { SystemBlock, WireMessage } from "../llm/types.ts";
import { encodeImageBlock } from "./images.ts";
import type { Texts } from "../texts/texts.ts";

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

function usableCaption(img: ImageRef): string | undefined {
  const caption = img.caption?.trim();
  return caption === undefined || caption === "" ? undefined : caption;
}

async function renderMessageContent(m: PromptMessage, texts: Texts): Promise<ContentBlock[] | undefined> {
  const images = m.images.filter((image) => image.embed === undefined);
  const own = m.role === "assistant";
  const turnImages = own || isToolResultOnly(m) ? [] : images;

  const content: ContentBlock[] = [];
  for (const img of turnImages) {
    const source = await encodeImageBlock(img);
    const kept = existsSync(img.path);
    const label = source !== undefined && kept ? texts.render("picture", { path: img.path }) : undefined;
    if (label !== undefined) content.push({ type: "text", text: label });
    if (source !== undefined) content.push({ type: "image", source });
    else if (!kept) content.push({ type: "text", text: texts.always("picture_gone", { name: imageLabel(img) }) });
  }
  content.push(...m.content_blocks.filter((block) => !(block.type === "text" && block.text.trim() === "")));
  if (own) for (const img of images) content.push({ type: "text", text: texts.always("sent_picture", { caption: usableCaption(img) }) });

  return content.length === 0 ? undefined : content;
}

export async function buildLlmMessages(
  prompt: Pick<AssembledPrompt, "system" | "messages"> & { sources?: readonly PromptSource[] },
  texts: Texts,
): Promise<{ messages: WireMessage[]; system: SystemBlock[]; sent: SentMessage[] }> {
  const messages: WireMessage[] = [];
  const sent: SentMessage[] = [];
  let added: string[] = [];

  for (const [index, m] of prompt.messages.entries()) {
    const content = await renderMessageContent(m, texts);
    if (content === undefined) {
      continue;
    }
    const source = prompt.sources?.[index];
    if (source?.msg_id === undefined) added.push(...textsOf(content));
    else {
      const own = new Set(m.content_blocks);
      const place = m.role === "assistant" ? "end" : "start";
      sent.push({
        msg_id: source.msg_id,
        notes: inReadingOrder([
          ...added.map((text): MessageNote => ({ place: "before", text })),
          ...textsOf(content.filter((block) => !own.has(block))).map((text): MessageNote => ({ place, text })),
          ...source.notes,
        ]),
      });
      added = [];
    }

    messages.push({
      role: m.role,
      content,
      ...(m.provider_key === undefined ? {} : { provider_key: m.provider_key }),
      ...(m.model === undefined ? {} : { model: m.model }),
    });
  }

  sent.at(-1)?.notes.push(...added.map((text): MessageNote => ({ place: "after", text })));

  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label }));

  return { messages, system, sent };
}
