import type { Nodes, Text } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

export interface Embed {
  source: string;
  target: string;
  label: string | undefined;
  wikilink: boolean;
  at: number;
}

const WIKILINK = /!\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g;

const WIKILINK_SIZE = /^\d+(x\d+)?$/;

const REMOTE = /^[a-z][a-z0-9+.-]*:|^\/\/|^\\\\/i;

function wikilink(match: RegExpMatchArray, at: number): Embed {
  const option = match[2]?.trim();
  return {
    source: match[0],
    target: (match[1] ?? "").trim(),
    label: option === undefined || option === "" || WIKILINK_SIZE.test(option) ? undefined : option,
    wikilink: true,
    at,
  };
}

function escaped(source: string, offset: number, start: number): boolean {
  let escapes = 0;
  while (offset - escapes > start && source[offset - escapes - 1] === "\\") escapes += 1;
  return escapes % 2 === 1;
}

export function localTarget(url: string): string | undefined {
  const target = url.split(/[?#]/, 1)[0] ?? "";
  if (target === "" || REMOTE.test(target)) return undefined;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

export function splitText(value: string, source: string): (string | Embed)[] {
  const raw = Array.from(source.matchAll(WIKILINK));
  const shown = Array.from(value.matchAll(WIKILINK));
  if (raw.length !== shown.length) return [value];
  const parts: (string | Embed)[] = [];
  let cursor = 0;
  for (const [index, match] of shown.entries()) {
    const original = raw[index];
    if (original === undefined || escaped(source, original.index, 0) || original[0] !== match[0]) continue;
    if (match.index > cursor) parts.push(value.slice(cursor, match.index));
    parts.push(wikilink(match, original.index));
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

function textEmbeds(source: string, node: Text): Embed[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return [];
  return splitText(node.value, source.slice(start, end)).flatMap((part) => typeof part === "string" ? [] : [{ ...part, at: part.at + start }]);
}

export function imageEmbed(source: string, node: { url: string; alt?: string | null | undefined; position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined }): Embed | undefined {
  const target = localTarget(node.url);
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (target === undefined || start === undefined || end === undefined) return undefined;
  return { source: source.slice(start, end), target, label: node.alt === null || node.alt === undefined || node.alt === "" ? undefined : node.alt, wikilink: false, at: start };
}

export function embedsIn(text: string): Embed[] {
  if (!text.includes("![")) return [];
  const found: Embed[] = [];
  const pending: Nodes[] = [fromMarkdown(text)];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === "text") found.push(...textEmbeds(text, node));
    if (node.type === "image") {
      const embed = imageEmbed(text, node);
      if (embed !== undefined) found.push(embed);
    }
    if ("children" in node) for (const child of node.children.toReversed()) pending.push(child);
  }
  return found;
}

export interface Sent {
  embed?: string | null | undefined;
  name?: string | null | undefined;
  problem?: string | null | undefined;
}

export function sentFor<T extends Sent>(images: readonly T[], embed: Embed): T | undefined {
  return images.find((image) => image.embed === embed.source);
}

export function embedName(embed: Embed): string {
  return embed.target.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? embed.target;
}

export function unsentNotice(images: readonly Sent[]): string | undefined {
  const problems = [...new Set(images.flatMap((image) => typeof image.embed === "string" && typeof image.problem === "string" ? [`${image.embed}: ${image.problem}`] : []))];
  if (problems.length === 0) return undefined;
  return `[These pictures in your last message were not sent, so only their names were shown:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nSend a picture again in a new message if you meant to show it.]`;
}

export function pictureText(text: string, images: readonly Sent[]): string {
  const sent = images.filter((image) => typeof image.embed === "string");
  if (sent.length === 0) return text;
  let result = "";
  let cursor = 0;
  for (const embed of embedsIn(text).toSorted((a, b) => a.at - b.at)) {
    const image = sentFor(sent, embed);
    if (image === undefined || embed.at < cursor) continue;
    result += text.slice(cursor, embed.at) + (typeof image.name === "string" && (image.problem === undefined || image.problem === null)
      ? `[picture: ${image.name}]`
      : `[picture not sent: ${embedName(embed)}]`);
    cursor = embed.at + embed.source.length;
  }
  return result + text.slice(cursor);
}
