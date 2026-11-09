export class TomlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlEditError";
  }
}

interface Header {
  path: readonly string[];
  line: number;
  arrayOfTables: boolean;
}

interface Assignment {
  path: readonly string[];
  startLine: number;
  endLine: number;
  keyText: string;
  table: Header | undefined;
}

interface Scan {
  assignments: Assignment[];
  headers: Header[];
}

interface Cursor {
  text: string;
  at: number;
}

function skipSpace(c: Cursor): void {
  while (c.text[c.at] === " " || c.text[c.at] === "\t") c.at += 1;
}

const BARE_KEY = /[A-Za-z0-9_-]/;

function readQuoted(c: Cursor, quote: string): string | undefined {
  c.at += 1;
  let out = "";
  for (;;) {
    const ch = c.text[c.at];
    if (ch === undefined) return undefined;
    if (ch === "\\" && quote === '"') {
      const next = c.text[c.at + 1];
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      c.at += 2;
      continue;
    }
    c.at += 1;
    if (ch === quote) return out;
    out += ch;
  }
}

function readKeyPath(c: Cursor): readonly string[] | undefined {
  const parts: string[] = [];
  for (;;) {
    skipSpace(c);
    const ch = c.text[c.at];
    if (ch === '"' || ch === "'") {
      const part = readQuoted(c, ch);
      if (part === undefined) return undefined;
      parts.push(part);
    } else {
      let bare = "";
      for (let next = ch; next !== undefined && BARE_KEY.test(next); next = c.text[c.at]) {
        bare += next;
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
  for (;;) {
    const ch = line[i];
    if (ch === undefined) return;
    if (state.multiline !== undefined) {
      if (line.startsWith(state.multiline, i)) {
        i += 3;
        state.multiline = undefined;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === "#") return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.multiline = line.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const c: Cursor = { text: line, at: i };
      readQuoted(c, ch);
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
  if (close === -1) return undefined;
  const c: Cursor = { text: trimmed.slice(open, close), at: 0 };
  const path = readKeyPath(c);
  if (path === undefined) return undefined;
  return { path, arrayOfTables };
}

function scanToml(source: string): Scan {
  const lines = source.split("\n");
  const assignments: Assignment[] = [];
  const headers: Header[] = [];
  let current: readonly string[] = [];
  let table: Header | undefined;
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i] as string;
    const trimmed = raw.trim();

    if (trimmed.startsWith("[")) {
      const parsed = headerPath(trimmed);
      if (parsed !== undefined) {
        current = parsed.path;
        table = { path: parsed.path, line: i, arrayOfTables: parsed.arrayOfTables };
        headers.push(table);
      }
      i += 1;
      continue;
    }

    const c: Cursor = { text: raw, at: 0 };
    const key = readKeyPath(c);
    if (key === undefined || c.text[c.at] !== "=") {
      i += 1;
      continue;
    }
    const keyText = raw.slice(0, c.at).trimEnd();

    const state: ValueState = { depth: 0, multiline: undefined };
    let end = i;
    advanceValue(raw, c.at + 1, state);
    while ((state.depth > 0 || state.multiline !== undefined) && end + 1 < lines.length) {
      end += 1;
      advanceValue(lines[end] as string, 0, state);
    }

    assignments.push({ path: [...current, ...key], startLine: i, endLine: end, keyText, table });
    i = end + 1;
  }

  return { assignments, headers };
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.every((part, i) => part === path[i]);
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
  return scan.assignments.filter((a) => a.table === header).at(-1)?.endLine ?? header.line;
}

type TomlWriteAction = "replaced" | "added-to-section" | "added-section";

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
    const replacement = `${existing.keyText} = ${literal}`;
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

export interface TomlRemoval {
  text: string;
  removed: boolean;
}

export function unsetTomlValue(source: string, path: readonly string[]): TomlRemoval {
  if (path.length === 0) throw new TomlEditError("empty config key");

  const scan = scanToml(source);
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
  if (existing === undefined) return { text: source, removed: false };

  const lines = source.split("\n");
  const next = [...lines.slice(0, existing.startLine), ...lines.slice(existing.endLine + 1)];
  return { text: next.join("\n"), removed: true };
}

interface Block {
  start: number;
  contentEnd: number;
  end: number;
  header: Header;
}

function nextHeaderLine(scan: Scan, after: number, total: number): number {
  return scan.headers.filter((h) => h.line > after).reduce<number>((best, h) => Math.min(best, h.line), total);
}

function blockOf(scan: Scan, lines: readonly string[], header: Header): Block {
  const limit = nextHeaderLine(scan, header.line, lines.length);
  const contentEnd = (scan.assignments.filter((a) => a.table === header).at(-1)?.endLine ?? header.line) + 1;
  let end = contentEnd;
  while (end < limit && (lines[end] as string).trim() === "") end += 1;
  let start = header.line;
  while (start > 0 && (lines[start - 1] as string).trim().startsWith("#")) start -= 1;
  return { start, contentEnd, end, header };
}

function arrayBlocks(scan: Scan, lines: readonly string[], path: readonly string[]): Block[] {
  return scan.headers.filter((h) => h.arrayOfTables && samePath(h.path, path)).map((h) => blockOf(scan, lines, h));
}

function refuseInline(scan: Scan, path: readonly string[]): void {
  const inline = scan.assignments.find((a) => isPrefix(a.path, path));
  if (inline !== undefined) {
    throw new TomlEditError(
      `\`${renderKey(path)}\` is written inline as \`${renderKey(inline.path)}\` on line ${inline.startLine + 1}; edit that line by hand`,
    );
  }
}

export function tomlArrayTableCount(source: string, path: readonly string[]): number {
  return scanToml(source).headers.filter((h) => h.arrayOfTables && samePath(h.path, path)).length;
}

export function tomlDefinesTable(source: string, path: readonly string[]): boolean {
  const scan = scanToml(source);
  return scan.headers.some((h) => isPrefix(path, h.path)) || scan.assignments.some((a) => isPrefix(path, a.path));
}

export function appendTomlArrayTable(
  source: string,
  path: readonly string[],
  fields: readonly (readonly [string, string])[],
  anchor?: readonly string[],
): string {
  const scan = scanToml(source);
  refuseInline(scan, path);
  const lines = source.split("\n");
  const body = [`[[${renderKey(path)}]]`, ...fields.map(([key, literal]) => `${quoteKey(key)} = ${literal}`)];
  const blocks = arrayBlocks(scan, lines, path);
  const last = blocks.at(-1);
  const anchorHeader = anchor === undefined ? undefined : scan.headers.find((h) => !h.arrayOfTables && samePath(h.path, anchor));
  const after = last?.contentEnd ?? (anchorHeader === undefined ? undefined : blockOf(scan, lines, anchorHeader).contentEnd);
  if (after === undefined) {
    const trailing = source === "" || source.endsWith("\n") ? "" : "\n";
    const gap = source.trim() === "" ? "" : "\n";
    return `${source}${trailing}${gap}${body.join("\n")}\n`;
  }
  return [...lines.slice(0, after), "", ...body, ...lines.slice(after)].join("\n");
}

function blockAt(scan: Scan, lines: readonly string[], path: readonly string[], index: number): Block {
  const block = arrayBlocks(scan, lines, path)[index];
  if (block === undefined) throw new TomlEditError(`\`${renderKey(path)}\` has no entry #${String(index + 1)}`);
  return block;
}

export function setTomlArrayTableValue(source: string, path: readonly string[], index: number, key: string, literal: string): string {
  const scan = scanToml(source);
  const lines = source.split("\n");
  const block = blockAt(scan, lines, path, index);
  const existing = scan.assignments.find((a) => a.table === block.header && samePath(a.path, [...path, key]));
  if (existing !== undefined) {
    return [...lines.slice(0, existing.startLine), `${existing.keyText} = ${literal}`, ...lines.slice(existing.endLine + 1)].join("\n");
  }
  return [...lines.slice(0, block.contentEnd), `${quoteKey(key)} = ${literal}`, ...lines.slice(block.contentEnd)].join("\n");
}

export function unsetTomlArrayTableValue(source: string, path: readonly string[], index: number, key: string): string {
  const scan = scanToml(source);
  const lines = source.split("\n");
  const block = blockAt(scan, lines, path, index);
  const existing = scan.assignments.find((a) => a.table === block.header && samePath(a.path, [...path, key]));
  if (existing === undefined) return source;
  return [...lines.slice(0, existing.startLine), ...lines.slice(existing.endLine + 1)].join("\n");
}

function dropRanges(lines: readonly string[], ranges: readonly { start: number; end: number }[]): string {
  const drop = new Set<number>();
  for (const range of ranges) for (let line = range.start; line < range.end; line += 1) drop.add(line);
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (drop.has(i)) continue;
    if (line.trim() === "" && drop.has(i - 1) && (out.at(-1)?.trim() ?? "") === "") continue;
    out.push(line);
  }
  while (out.length > 1 && (out.at(-1) as string) === "" && (out.at(-2) as string).trim() === "") out.pop();
  return out.join("\n");
}

export function removeTomlArrayTable(source: string, path: readonly string[], index: number): string {
  const scan = scanToml(source);
  const lines = source.split("\n");
  return dropRanges(lines, [blockAt(scan, lines, path, index)]);
}

export function reorderTomlArrayTables(source: string, path: readonly string[], order: readonly number[]): string {
  const scan = scanToml(source);
  const lines = source.split("\n");
  const blocks = arrayBlocks(scan, lines, path);
  if (order.length !== blocks.length || new Set(order).size !== blocks.length || order.some((i) => blocks[i] === undefined)) {
    throw new TomlEditError(`a new order for \`${renderKey(path)}\` must name each of its ${String(blocks.length)} entries once`);
  }
  const out: string[] = [];
  let cursor = 0;
  for (const [slot, block] of blocks.entries()) {
    out.push(...lines.slice(cursor, block.start));
    const moved = blocks[order[slot] as number] as Block;
    out.push(...lines.slice(moved.start, moved.contentEnd));
    cursor = block.contentEnd;
  }
  out.push(...lines.slice(cursor));
  return out.join("\n");
}

export function removeTomlTable(source: string, path: readonly string[]): string {
  const scan = scanToml(source);
  const lines = source.split("\n");
  const ranges: Array<{ start: number; end: number }> = scan.headers.filter((h) => isPrefix(path, h.path)).map((h) => blockOf(scan, lines, h));
  for (const a of scan.assignments) {
    if (isPrefix(path, a.path) || isPrefix(a.path, path)) ranges.push({ start: a.startLine, end: a.endLine + 1 });
  }
  return dropRanges(lines, ranges);
}
