export class TomlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlEditError";
  }
}

interface Assignment {
  path: readonly string[];
  startLine: number;
  endLine: number;
  indent: string;
  keyText: string;
}

interface Header {
  path: readonly string[];
  line: number;
  arrayOfTables: boolean;
}

export interface Scan {
  assignments: Assignment[];
  headers: Header[];
}

interface Cursor {
  text: string;
  at: number;
}

function skipSpace(c: Cursor): void {
  while (c.at < c.text.length && (c.text[c.at] === " " || c.text[c.at] === "\t")) c.at += 1;
}

const BARE_KEY = /[A-Za-z0-9_-]/;

function readQuoted(c: Cursor, quote: string): string | undefined {
  c.at += 1;
  let out = "";
  while (c.at < c.text.length) {
    const ch = c.text[c.at] as string;
    if (ch === "\\" && quote === '"') {
      const next = c.text[c.at + 1];
      if (next === undefined) return undefined;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      c.at += 2;
      continue;
    }
    if (ch === quote) {
      c.at += 1;
      return out;
    }
    out += ch;
    c.at += 1;
  }
  return undefined;
}

function readKeyPath(c: Cursor): readonly string[] | undefined {
  const parts: string[] = [];
  for (;;) {
    skipSpace(c);
    const ch = c.text[c.at];
    if (ch === undefined) return undefined;
    if (ch === '"' || ch === "'") {
      const part = readQuoted(c, ch);
      if (part === undefined) return undefined;
      parts.push(part);
    } else {
      let bare = "";
      while (c.at < c.text.length && BARE_KEY.test(c.text[c.at] as string)) {
        bare += c.text[c.at];
        c.at += 1;
      }
      if (bare === "") return undefined;
      parts.push(bare);
    }
    skipSpace(c);
    if (c.text[c.at] === ".") {
      c.at += 1;
      continue;
    }
    return parts;
  }
}

interface ValueState {
  depth: number;
  multiline: string | undefined;
}

function advanceValue(line: string, from: number, state: ValueState): void {
  let i = from;
  while (i < line.length) {
    if (state.multiline !== undefined) {
      if (line.startsWith(state.multiline, i)) {
        i += 3;
        state.multiline = undefined;
        continue;
      }
      i += 1;
      continue;
    }
    const ch = line[i] as string;
    if (ch === "#") return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.multiline = line.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const c: Cursor = { text: line, at: i };
      if (readQuoted(c, ch) === undefined) return;
      i = c.at;
      continue;
    }
    if (ch === "[" || ch === "{") state.depth += 1;
    if (ch === "]" || ch === "}") state.depth -= 1;
    i += 1;
  }
}

function headerPath(
  trimmed: string,
): { path: readonly string[]; arrayOfTables: boolean } | undefined {
  const arrayOfTables = trimmed.startsWith("[[");
  const open = arrayOfTables ? 2 : 1;
  const close = trimmed.lastIndexOf(arrayOfTables ? "]]" : "]");
  if (close <= open) return undefined;
  const c: Cursor = { text: trimmed.slice(open, close), at: 0 };
  const path = readKeyPath(c);
  if (path === undefined) return undefined;
  return { path, arrayOfTables };
}

export function scanToml(source: string): Scan {
  const lines = source.split("\n");
  const assignments: Assignment[] = [];
  const headers: Header[] = [];
  let current: readonly string[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i] as string;
    const trimmed = raw.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("[")) {
      const parsed = headerPath(trimmed);
      if (parsed !== undefined) {
        current = parsed.path;
        headers.push({ path: parsed.path, line: i, arrayOfTables: parsed.arrayOfTables });
      }
      i += 1;
      continue;
    }

    const c: Cursor = { text: raw, at: 0 };
    skipSpace(c);
    const indent = raw.slice(0, c.at);
    const keyStart = c.at;
    const key = readKeyPath(c);
    if (key === undefined || c.text[c.at] !== "=") {
      i += 1;
      continue;
    }
    const keyText = raw.slice(keyStart, c.at).trimEnd();

    const state: ValueState = { depth: 0, multiline: undefined };
    let end = i;
    advanceValue(raw, c.at + 1, state);
    while ((state.depth > 0 || state.multiline !== undefined) && end + 1 < lines.length) {
      end += 1;
      advanceValue(lines[end] as string, 0, state);
    }

    assignments.push({ path: [...current, ...key], startLine: i, endLine: end, indent, keyText });
    i = end + 1;
  }

  return { assignments, headers };
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, i) => part === path[i]);
}

function quoteKey(part: string): string {
  return /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part);
}

function renderKey(path: readonly string[]): string {
  return path.map(quoteKey).join(".");
}

function insertionPoint(scan: Scan, table: readonly string[]): number | undefined {
  const header = scan.headers.find((h) => !h.arrayOfTables && samePath(h.path, table));
  if (header === undefined) return undefined;

  const nextHeader = scan.headers
    .filter((h) => h.line > header.line)
    .reduce<number>((best, h) => Math.min(best, h.line), Number.POSITIVE_INFINITY);

  let last = header.line;
  for (const a of scan.assignments) {
    if (a.startLine > header.line && a.startLine < nextHeader && a.endLine > last) {
      last = a.endLine;
    }
  }
  return last;
}

export type TomlWriteAction = "replaced" | "added-to-section" | "added-section";

export interface TomlWrite {
  text: string;
  action: TomlWriteAction;
}

export function setTomlValue(source: string, path: readonly string[], literal: string): TomlWrite {
  if (path.length === 0) throw new TomlEditError("empty config key");

  const scan = scanToml(source);
  const lines = source.split("\n");

  const shadowing = scan.assignments.find(
    (a) => a.path.length < path.length && isPrefix(a.path, path),
  );
  if (shadowing !== undefined) {
    throw new TomlEditError(
      `\`${renderKey(path)}\` lives inside the value of \`${renderKey(shadowing.path)}\` ` +
        `on line ${shadowing.startLine + 1}; edit that line by hand`,
    );
  }

  const existing = scan.assignments.find((a) => samePath(a.path, path));
  if (existing !== undefined) {
    const replacement = `${existing.indent}${existing.keyText} = ${literal}`;
    const next = [
      ...lines.slice(0, existing.startLine),
      replacement,
      ...lines.slice(existing.endLine + 1),
    ];
    return { text: next.join("\n"), action: "replaced" };
  }

  for (let cut = path.length - 1; cut >= 1; cut -= 1) {
    const point = insertionPoint(scan, path.slice(0, cut));
    if (point === undefined) continue;
    const line = `${renderKey(path.slice(cut))} = ${literal}`;
    const next = [...lines.slice(0, point + 1), line, ...lines.slice(point + 1)];
    return { text: next.join("\n"), action: "added-to-section" };
  }

  const table = path.slice(0, -1);
  const body =
    table.length === 0
      ? `${renderKey(path)} = ${literal}`
      : `[${renderKey(table)}]\n${renderKey(path.slice(-1))} = ${literal}`;
  const trailing = source === "" || source.endsWith("\n") ? "" : "\n";
  const gap = source.trim() === "" ? "" : "\n";
  return { text: `${source}${trailing}${gap}${body}\n`, action: "added-section" };
}

export function tomlKeyDefined(source: string, path: readonly string[]): boolean {
  return scanToml(source).assignments.some((a) => samePath(a.path, path));
}
