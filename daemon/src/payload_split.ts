const SPLIT_KEYS = new Set(["messages", "tools", "contents", "system", "input", "turns"]);

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const LITERAL_END = new Set([",", "}", "]", " ", "\t", "\n", "\r"]);

class ScanError extends Error {}

export function splitJsonPayload(text: string): string[] | null {
  if (text.length === 0) return null;
  let cuts: Set<number>;
  try {
    cuts = elementCuts(text);
  } catch {
    return null;
  }
  if (cuts.size === 0) return null;

  const points = [...new Set([0, ...cuts, text.length])].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const part = text.slice(points[i]!, points[i + 1]!);
    if (part.length > 0) parts.push(part);
  }
  return parts.length > 1 ? parts : null;
}

function elementCuts(text: string): Set<number> {
  const cuts = new Set<number>();
  let i = skipWhitespace(text, 0);
  if (text[i] !== "{") throw new ScanError("not an object");

  for (const member of objectMembers(text, i)) {
    if (!SPLIT_KEYS.has(member.key)) continue;
    if (text[member.valueStart] !== "[") continue;
    for (const [start, end] of arrayElements(text, member.valueStart)) {
      cuts.add(start);
      cuts.add(end);
    }
  }
  return cuts;
}

interface Member {
  key: string;
  valueStart: number;
  valueEnd: number;
}

function objectMembers(text: string, open: number): Member[] {
  const members: Member[] = [];
  let i = skipWhitespace(text, open + 1);
  if (text[i] === "}") return members;

  for (;;) {
    if (text[i] !== '"') throw new ScanError("expected a key");
    const keyEnd = scanString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;

    i = skipWhitespace(text, keyEnd);
    if (text[i] !== ":") throw new ScanError("expected a colon");

    const valueStart = skipWhitespace(text, i + 1);
    const valueEnd = scanValue(text, valueStart);
    members.push({ key, valueStart, valueEnd });

    i = skipWhitespace(text, valueEnd);
    if (text[i] === ",") {
      i = skipWhitespace(text, i + 1);
      continue;
    }
    if (text[i] === "}") return members;
    throw new ScanError("expected a comma or a closing brace");
  }
}

function arrayElements(text: string, open: number): [number, number][] {
  const spans: [number, number][] = [];
  let i = skipWhitespace(text, open + 1);
  if (text[i] === "]") return spans;

  for (;;) {
    const end = scanValue(text, i);
    spans.push([i, end]);

    i = skipWhitespace(text, end);
    if (text[i] === ",") {
      i = skipWhitespace(text, i + 1);
      continue;
    }
    if (text[i] === "]") return spans;
    throw new ScanError("expected a comma or a closing bracket");
  }
}

function scanValue(text: string, start: number): number {
  const c = text[start];
  if (c === undefined) throw new ScanError("value ran off the end");
  if (c === '"') return scanString(text, start);
  if (c === "{") return scanNested(text, start, "{", "}");
  if (c === "[") return scanNested(text, start, "[", "]");

  let i = start;
  while (i < text.length && !LITERAL_END.has(text[i]!)) i++;
  if (i === start) throw new ScanError("empty value");
  return i;
}

function scanNested(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      i = scanString(text, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new ScanError("unterminated container");
}

function scanString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  throw new ScanError("unterminated string");
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && WHITESPACE.has(text[i]!)) i++;
  return i;
}
