/**
 * The config-local `.env`, which is where Shore's provider keys actually live.
 *
 * Ports the `dotenvy::from_path_override` call in
 * `crates/common/src/config/mod.rs::load_raw_config_table`. The Rust reached for
 * a crate; there is no equivalent dependency here, and the format is small
 * enough that the parser is cheaper than the dependency — so the grammar
 * dotenvy accepts is reproduced below rather than imported.
 *
 * # Why this file is load-bearing
 *
 * `[providers.<key>] api_key_env` names an environment variable, and
 * `readCandidateEnv` reads it off `process.env` at the moment of the call. In a
 * container nothing else populates those variables: the compose file passes
 * `TZ` and the Shore directories and no secrets at all, because the keys are
 * mounted as `/config/.env` instead. A daemon that does not read this file has
 * no credentials for any provider, and every generation fails before it reaches
 * the network.
 *
 * # `override`, not `fill`
 *
 * dotenvy has both, and the Rust chose `from_path_override`: a value in the
 * file wins over one already in the process environment. That is the direction
 * that lets the mounted file be the source of truth regardless of what the
 * image or the shell happened to export, and it is what {@link applyDotenv}
 * does.
 */

import { readFileSync } from "node:fs";

/** A `.env` that exists but does not parse. */
export class DotenvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DotenvError";
  }
}

/**
 * Parse `.env` text into ordered pairs.
 *
 * The grammar, which is dotenvy's:
 *
 * - `KEY=value`, with optional `export ` in front and optional whitespace
 *   around the `=`.
 * - Blank lines, and lines whose first non-whitespace character is `#`, are
 *   skipped.
 * - A single-quoted value is literal: no escapes, no substitution, and it may
 *   span newlines.
 * - A double-quoted value takes backslash escapes (`\n`, `\t`, `\r`, `\f`,
 *   `\b`, and any other character as itself) and `$VAR` / `${VAR}`
 *   substitution, and may span newlines.
 * - An unquoted value runs to the end of the line, takes the same escapes and
 *   substitution, loses its trailing whitespace, and ends early at a `#` that
 *   follows whitespace. `KEY=a#b` is therefore `a#b`, while `KEY=a #b` is `a`.
 * - Substitution resolves against earlier pairs in this same file first, then
 *   `lookup`, and an unset name expands to the empty string. `\$` is a literal
 *   `$`.
 *
 * @param lookup the environment substitution falls back to.
 * @throws {DotenvError} on an unterminated quote or a line with no `=`.
 */
export function parseDotenv(
  content: string,
  lookup: (name: string) => string | undefined = (name) => process.env[name],
): [string, string][] {
  const pairs: [string, string][] = [];
  // Earlier assignments are visible to later ones, which is why this is built
  // as it goes rather than after the loop.
  const own = new Map<string, string>();
  const resolve = (name: string): string => own.get(name) ?? lookup(name) ?? "";

  let i = 0;
  while (i < content.length) {
    // Between entries, every kind of whitespace is skippable — including the
    // newlines that separate them, so blank lines need no special case.
    while (i < content.length && isSpace(content[i]!)) i += 1;
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
    i += 1; // the `=`

    while (i < content.length && isBlank(content[i]!)) i += 1;

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

    // A quoted value can stop mid-line; whatever follows it is a comment.
    i = endOfLine(content, i);
  }

  return pairs;
}

/**
 * Read `path` and apply it over `target`, file wins.
 *
 * Returns the keys applied, in file order.
 *
 * Unlike dotenvy, a file that fails to parse applies *nothing*: dotenvy sets
 * each pair as it reads it and returns the error from the line it choked on,
 * leaving the prefix applied. Parsing whole-file-then-applying is the
 * deliberate deviation — a half-applied credential file is harder to reason
 * about than one that was rejected, and the caller reports the failure either
 * way.
 *
 * @throws {DotenvError} if the file cannot be read or does not parse.
 */
export function applyDotenv(
  path: string,
  target: Record<string, string | undefined> = process.env,
): string[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    throw new DotenvError(e instanceof Error ? e.message : String(e));
  }

  // Substitution reads through to what is already set, so an entry can be
  // written in terms of a variable the process was started with.
  const pairs = parseDotenv(content, (name) => target[name]);
  for (const [key, value] of pairs) target[key] = value;
  return pairs.map(([key]) => key);
}

// ── scanning ────────────────────────────────────────────────────────────

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isBlank = (c: string): boolean => c === " " || c === "\t";

/** Index just past the next newline, or the end. */
function endOfLine(content: string, from: number): number {
  const at = content.indexOf("\n", from);
  return at < 0 ? content.length : at + 1;
}

/** Step over a leading `export`, but only when it is a word of its own. */
function skipExport(content: string, from: number): number {
  if (!content.startsWith("export", from)) return from;
  let i = from + "export".length;
  if (i >= content.length || !isBlank(content[i]!)) return from;
  while (i < content.length && isBlank(content[i]!)) i += 1;
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
    const c = content[i]!;
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
  // Whitespace is held back rather than appended, so trailing whitespace never
  // lands in the value and no trim is needed afterwards — which matters because
  // a trim would also eat whitespace that came *out of* a substitution.
  let pending = "";
  let i = from;
  while (i < content.length) {
    const c = content[i]!;
    if (c === "\n") break;
    if (isBlank(c)) {
      pending += c;
      i += 1;
      continue;
    }
    // A `#` after whitespace, or at the very start, begins a comment. One
    // inside the value — `a#b` — is just a character.
    if (c === "#" && (pending !== "" || out === "")) break;

    out += pending;
    pending = "";

    if (c === "\\") {
      const next = content[i + 1];
      if (next === undefined) break;
      // A backslash-newline continues the value onto the next line.
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

/**
 * Expand `$NAME` or `${NAME}` at `from`, which points at the `$`.
 *
 * A `$` that begins neither form is a literal `$` — `pa$$word` survives intact.
 */
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
  while (i < content.length && isNameChar(content[i]!, i === from + 1)) i += 1;
  if (i === from + 1) return ["$", from + 1];
  return [resolve(content.slice(from + 1, i)), i];
}

const isNameChar = (c: string, first: boolean): boolean =>
  c === "_" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (!first && c >= "0" && c <= "9");

/** The escapes dotenvy recognises; anything else stands for itself. */
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
