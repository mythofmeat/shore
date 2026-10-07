export function rustLines(text: string): string[] {
  const parts = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const WHITESPACE_START = /^\p{White_Space}+/u;
const WHITESPACE_END = /\p{White_Space}+$/u;

function rustTrimStart(text: string): string {
  return text.replace(WHITESPACE_START, "");
}

function rustTrimEnd(text: string): string {
  return text.replace(WHITESPACE_END, "");
}

export function rustTrim(text: string): string {
  return rustTrimEnd(rustTrimStart(text));
}

export function compareRustStrings(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
