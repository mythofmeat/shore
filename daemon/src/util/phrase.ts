import { required } from "./required.ts";

const MARKUP = new Set(["*", "_", "`", "~"]);
const LINE_MARKER = /^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;

export interface Plain {
  text: string;
  at: number[];
}

export function plainOf(source: string): Plain {
  const text: string[] = [];
  const at: number[] = [];
  let lineStart = true;
  let space = false;
  for (let index = 0; index < source.length; index += 1) {
    if (lineStart) {
      const marker = LINE_MARKER.exec(source.slice(index))?.[0] ?? "";
      index += marker.length;
      lineStart = false;
      if (index >= source.length) break;
    }
    const char = source[index] ?? "";
    if (char === "\n") lineStart = true;
    if (/\s/.test(char)) {
      space = text.length > 0;
      continue;
    }
    if (MARKUP.has(char) || char === "[") continue;
    if (char === "]" && source[index + 1] === "(") {
      const close = source.indexOf(")", index + 2);
      if (close !== -1) {
        index = close;
        continue;
      }
    }
    if (space) {
      text.push(" ");
      at.push(index);
      space = false;
    }
    for (const lower of char.toLowerCase()) {
      text.push(lower);
      at.push(index);
    }
  }
  return { text: text.join(""), at };
}

export function locatePhrase(source: string, phrase: string): string | undefined {
  const wanted = plainOf(phrase).text;
  if (wanted === "") return undefined;
  const plain = plainOf(source);
  const start = plain.text.indexOf(wanted);
  if (start === -1) return undefined;
  let from = required(plain.at[start]);
  let to = required(plain.at[start + wanted.length - 1]) + 1;
  while (from > 0 && MARKUP.has(source[from - 1] ?? "")) from -= 1;
  while (to < source.length && MARKUP.has(source[to] ?? "")) to += 1;
  return source.slice(from, to);
}
