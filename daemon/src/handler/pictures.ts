import { basename, extname } from "node:path";

import { embedsIn, type Embed } from "../engine/embeds.ts";
import type { ContentBlock, ImageRef } from "../engine/types.ts";
import { keepSentPicture, shownPicturePath } from "../storage/sent_pictures.ts";
import type { CharacterWorkspace } from "../tools/character_workspace.ts";
import type { PictureLookup } from "../tools/message_pictures.ts";
import type { NotificationPicture } from "../notifications.ts";
import { imageMime } from "../tools/read_image.ts";

export const MAX_SENT_PICTURES = 10;

export interface PictureSender {
  workspace: CharacterWorkspace;
  dir: string;
}

const TOO_MANY = `only the first ${String(MAX_SENT_PICTURES)} pictures in a message are sent`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function textsOf(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((block) => block.type === "text" ? [block.text] : []);
}

function messageEmbeds(texts: readonly string[]): Embed[] {
  const seen = new Set<string>();
  return texts.flatMap((text) => embedsIn(text)).filter((embed) => {
    if (seen.has(embed.source)) return false;
    seen.add(embed.source);
    return true;
  });
}

async function lookUp(embeds: readonly Embed[], workspace: CharacterWorkspace, signal?: AbortSignal): Promise<PictureLookup[]> {
  const wanted = embeds.slice(0, MAX_SENT_PICTURES);
  if (wanted.length === 0) return [];
  return await workspace.call("pictures", { workspaceDir: workspace.dir, targets: wanted.map(({ target, wikilink }) => ({ target, wikilink })) }, signal);
}

function unsent(embed: Embed, problem: string): ImageRef {
  return { path: "", embed: embed.source, problem };
}

async function keep(embed: Embed, path: string, sender: PictureSender, signal?: AbortSignal): Promise<ImageRef> {
  const [read] = await sender.workspace.call("readFiles", { paths: [path] }, signal);
  if (read === undefined || "error" in read) throw new Error(read?.error.message ?? "it could not be read");
  const bytes = Buffer.from(read.data, "base64");
  const mime = imageMime(bytes.subarray(0, 12));
  if (mime === undefined) throw new Error("it is not a PNG, JPEG, GIF or WebP picture");
  return {
    path: await keepSentPicture(sender.dir, bytes, mime),
    embed: embed.source,
    name: basename(path),
    ...(embed.label === undefined ? {} : { caption: embed.label }),
  };
}

export async function sendPictures(texts: readonly string[], sender: PictureSender, signal?: AbortSignal): Promise<ImageRef[]> {
  const embeds = messageEmbeds(texts);
  let lookups: PictureLookup[];
  try {
    lookups = await lookUp(embeds, sender.workspace, signal);
  } catch (error) {
    signal?.throwIfAborted();
    lookups = embeds.map(() => ({ problem: `the workspace could not be searched: ${message(error)}` }));
  }
  const images: ImageRef[] = [];
  for (const [index, embed] of embeds.entries()) {
    const found = index < MAX_SENT_PICTURES ? lookups[index] : { problem: TOO_MANY };
    if (found === null || found === undefined) continue;
    if ("problem" in found) {
      images.push(unsent(embed, found.problem));
      continue;
    }
    try {
      images.push(await keep(embed, found.path, sender, signal));
    } catch (error) {
      signal?.throwIfAborted();
      images.push(unsent(embed, `it could not be sent: ${message(error)}`));
    }
  }
  return images;
}

export async function pictureProblems(texts: readonly string[], workspace: CharacterWorkspace, signal?: AbortSignal): Promise<string[]> {
  const embeds = messageEmbeds(texts);
  const lookups = await lookUp(embeds, workspace, signal);
  return embeds.flatMap((embed, index) => {
    const found = index < MAX_SENT_PICTURES ? lookups[index] : { problem: TOO_MANY };
    return found !== null && found !== undefined && "problem" in found ? [`${embed.source}: ${found.problem}`] : [];
  });
}

export function isSent(image: ImageRef): boolean {
  return image.embed !== undefined && image.problem === undefined && image.path !== "";
}

export function firstSentPicture(images: readonly ImageRef[]): NotificationPicture | undefined {
  const first = images.find(isSent);
  if (first === undefined) return undefined;
  const path = shownPicturePath(first.path);
  const name = first.name ?? basename(path);
  return { path, name: `${name.replace(/\.[^.]*$/, "")}${extname(path)}` };
}
