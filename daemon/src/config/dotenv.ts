import { required } from "../util/required.ts";

import { readFileSync } from "node:fs";

export class DotenvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DotenvError";
  }
}

export function parseDotenv(
  content: string,
  lookup: (name: string) => string | undefined = (name) => process.env[name],
): [string, string][] {
  const pairs: [string, string][] = [];
  const own = new Map<string, string>();
  const resolve = (name: string): string => own.get(name) ?? lookup(name) ?? "";

  let i = 0;
  while (i < content.length) {
    while (i < content.length && isSpace(required(content[i]))) i += 1;
    if (i >= content.length) break;

    if (content[i] === "#") {
      i = endOfLine(content, i);
      continue;
    }

    i = skipExport(content, i);

    const keyStart = i;
    while (i < content.length && content[i] !== "=" && content[i] !== "\n") i += 1;
    if (i >= content.length || content[i] === "\n") {
      throw new DotenvError(`line has no '=': ${content.slice(keyStart, i).trim()}`);
    }
    const key = content.slice(keyStart, i).trim();
    if (key === "") throw new DotenvError("line has an empty key");
    i += 1;

    while (i < content.length && isBlank(required(content[i]))) i += 1;

    let value: string;
    const quote = content[i];
    if (quote === "'") {
      [value, i] = readSingleQuoted(content, i + 1);
    } else if (quote === '"') {
      [value, i] = readDoubleQuoted(content, i + 1, resolve);
    } else {
      [value, i] = readUnquoted(content, i, resolve);
    }

    own.set(key, value);
    pairs.push([key, value]);

    i = endOfLine(content, i);
  }

  return pairs;
}

type Environment = Record<string, string | undefined>;
const overlays = new WeakMap<Environment, Map<string, Map<string, { inherited: string | undefined; value: string }>>>();

export function prepareDotenv(
  path: string,
  target: Environment = process.env,
  allowMissing = false,
): { keys: string[]; adopt: () => void } {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    if (allowMissing && (e as NodeJS.ErrnoException).code === "ENOENT") content = "";
    else throw new DotenvError(e instanceof Error ? e.message : String(e));
  }
  const prior = overlays.get(target)?.get(path) ?? new Map<string, { inherited: string | undefined; value: string }>();
  const inherited = (key: string) => {
    const previous = prior.get(key);
    return previous !== undefined && target[key] === previous.value ? previous.inherited : target[key];
  };
  const pairs = parseDotenv(content, inherited);
  const next = new Map(pairs.map(([key, value]) => [key, { inherited: inherited(key), value }]));
  let adopted = false;
  return { keys: pairs.map(([key]) => key), adopt: () => {
    if (adopted) return;
    adopted = true;
    for (const key of prior.keys()) {
      if (next.has(key)) continue;
      const value = inherited(key);
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
    for (const [key, entry] of next) target[key] = entry.value;
    const paths = overlays.get(target) ?? new Map<string, Map<string, { inherited: string | undefined; value: string }>>();
    paths.set(path, next);
    overlays.set(target, paths);
  } };
}

export function applyDotenv(path: string, target: Environment = process.env): string[] {
  const candidate = prepareDotenv(path, target);
  candidate.adopt();
  return candidate.keys;
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isBlank = (c: string): boolean => c === " " || c === "\t";

function endOfLine(content: string, from: number): number {
  const at = content.indexOf("\n", from);
  return at < 0 ? content.length : at + 1;
}

function skipExport(content: string, from: number): number {
  if (!content.startsWith("export", from)) return from;
  let i = from + "export".length;
  if (i >= content.length || !isBlank(required(content[i]))) return from;
  while (i < content.length && isBlank(required(content[i]))) i += 1;
  return i;
}

function readSingleQuoted(content: string, from: number): [string, number] {
  const close = content.indexOf("'", from);
  if (close < 0) throw new DotenvError("unterminated single-quoted value");
  return [content.slice(from, close), close + 1];
}

function readDoubleQuoted(
  content: string,
  from: number,
  resolve: (name: string) => string,
): [string, number] {
  let out = "";
  let i = from;
  while (i < content.length) {
    const c = required(content[i]);
    if (c === '"') return [out, i + 1];
    if (c === "\\") {
      const next = content[i + 1];
      if (next === undefined) break;
      out += unescape(next);
      i += 2;
      continue;
    }
    if (c === "$") {
      const [text, next] = readSubstitution(content, i, resolve);
      out += text;
      i = next;
      continue;
    }
    out += c;
    i += 1;
  }
  throw new DotenvError("unterminated double-quoted value");
}

function readUnquoted(
  content: string,
  from: number,
  resolve: (name: string) => string,
): [string, number] {
  let out = "";
  let pending = "";
  let i = from;
  while (i < content.length) {
    const c = required(content[i]);
    if (c === "\n") break;
    if (isBlank(c)) {
      pending += c;
      i += 1;
      continue;
    }
    if (c === "#" && (pending !== "" || out === "")) break;

    out += pending;
    pending = "";

    if (c === "\\") {
      const next = content[i + 1];
      if (next === undefined) break;
      if (next !== "\n") out += unescape(next);
      i += 2;
      continue;
    }
    if (c === "$") {
      const [text, next] = readSubstitution(content, i, resolve);
      out += text;
      i = next;
      continue;
    }
    out += c;
    i += 1;
  }
  return [out, i];
}

function readSubstitution(
  content: string,
  from: number,
  resolve: (name: string) => string,
): [string, number] {
  if (content[from + 1] === "{") {
    const close = content.indexOf("}", from + 2);
    if (close < 0) return ["$", from + 1];
    return [resolve(content.slice(from + 2, close)), close + 1];
  }

  let i = from + 1;
  while (i < content.length && isNameChar(required(content[i]), i === from + 1)) i += 1;
  if (i === from + 1) return ["$", from + 1];
  return [resolve(content.slice(from + 1, i)), i];
}

const isNameChar = (c: string, first: boolean): boolean =>
  c === "_" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (!first && c >= "0" && c <= "9");

function unescape(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "f":
      return "\f";
    case "b":
      return "\b";
    default:
      return c;
  }
}
