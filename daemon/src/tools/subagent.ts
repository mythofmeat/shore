/**
 * Sub-agent prompt assembly.
 *
 * Ported from `crates/daemon/src/tools/subagent.rs`, pinned by
 * `tests/engine_fixtures/subagent_parity.json`.
 *
 * A `[subagents.<name>]` config entry surfaces to the primary model as a
 * single `ask_<name>(query)` tool. Invoking it runs a *nested* tool loop on a
 * (typically cheaper) model over a subset of the in-process tools, then
 * returns only the agent's final text. The bulky intermediate tool results
 * never enter the primary model's context, and the primary model's tool
 * surface stays small — that is the cost/compression win.
 *
 * What lives here is the part that decides *what the sub-agent is told*:
 * prompt macro expansion, the conversation transcript it may see, and the
 * tool subset it is offered. Driving the nested loop is the caller's job.
 *
 * # The two-phase render, and why the order is the security boundary
 *
 * A sub-agent's system prompt is built in two passes that must run in this
 * order:
 *
 * 1. {@link renderTemplate} substitutes `{{char}}` / `{{user}}` / `{{#if}}`
 *    over the **authored** prompt. That text is trusted — it came from the
 *    config file.
 * 2. {@link expandPromptMacros} expands the sub-agent-only `{{file:}}` and
 *    `{{active_history:}}` macros.
 *
 * Macro output is inserted as a **terminal**. It is never re-scanned, for
 * macros or for anything else. That is what makes the boundary hold: a chat
 * message is untrusted input, and a user who types `{{file: ~/.ssh/id_rsa}}`
 * into the conversation must not thereby cause a file read whose contents are
 * shipped to an external provider. Because expansion happens *after* the var
 * pass and its output is never revisited, the literal text survives into the
 * prompt unexpanded — visible to the sub-agent as text, inert as a macro.
 *
 * Running the passes the other way round, or looping expansion to a fixed
 * point, reopens exactly that hole.
 */

import { readFileSync } from "node:fs";
import { activePromptFile, normalizePromptVisiblePath, resolvePath } from "./workspace_path";
import type { ContentBlock, Message } from "../engine/types";

/**
 * Cap on a single `{{active_history: n}}` expansion, and on the conversation
 * tail a caller clones for one. Bounds both the per-turn copy and the rendered
 * transcript, so neither grows with the conversation.
 */
export const MAX_HISTORY_MESSAGES = 100;

/** Reads a workspace file, or reports why it could not be read. */
export interface PromptFileReader {
  read: (path: string) => string | undefined;
}

/** Notified when a `{{file:}}` target is refused or unreadable. */
export type MacroWarn = (path: string, reason: string) => void;

/** Everything {@link expandPromptMacros} needs to resolve its macros. */
export interface MacroContext {
  characterDataDir: string;
  workspaceDir: string;
  history: readonly Message[];
  charName: string;
  userName: string;
  /** Injected so tests need no filesystem; defaults to reading real files. */
  readFile?: (path: string) => string | undefined;
  /** Injected for assertions; defaults to dropping the warning. */
  warn?: MacroWarn;
}

// ── Template variables ──────────────────────────────────────────────────

/**
 * The `{{char}}` / `{{user}}` / `{{date}}` / `{{time}}` substitution table.
 *
 * A sub-agent runs in its own LLM call and never sees the conversation's
 * injected time markers, so `{{date}}` and `{{time}}` are the only way its
 * prompt can anchor to "now" — they are filled from the live clock rather than
 * left blank.
 */
export function templateVars(
  charName: string,
  displayName: string,
  now: () => Date = () => new Date(),
): Map<string, string> {
  const at = now();
  return new Map([
    ["char", charName],
    ["character_name", charName],
    ["user", displayName],
    ["date", formatFriendlyDate(at)],
    ["time", formatFriendlyTime(at)],
  ]);
}

function formatFriendlyDate(at: Date): string {
  return at.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatFriendlyTime(at: Date): string {
  return at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ── Macro expansion ─────────────────────────────────────────────────────

/**
 * Expand `{{file: <path>}}` and `{{active_history: <n>}}` in an
 * already-var-substituted prompt.
 *
 * Any other `{{...}}` is passed through verbatim — it is either a var the
 * earlier pass did not resolve, or literal text that happens to look like one.
 * An unterminated `{{` ends the scan and is emitted as-is.
 *
 * Neither macro's output is re-scanned. See the module docs for why that is
 * the whole point rather than an optimization.
 */
export function expandPromptMacros(text: string, ctx: MacroContext): string {
  let out = "";
  let rest = text;

  for (;;) {
    const open = rest.indexOf("{{");
    if (open === -1) break;

    out += rest.slice(0, open);
    const after = rest.slice(open + 2);
    const close = after.indexOf("}}");
    if (close === -1) {
      // Unterminated: emit from `{{` onward verbatim and stop scanning.
      return out + rest.slice(open);
    }

    const innerRaw = after.slice(0, close);
    const inner = innerRaw.trim();

    if (inner.startsWith("file:")) {
      out += readPromptFile(inner.slice("file:".length).trim(), ctx);
    } else if (inner.startsWith("active_history:")) {
      out += renderHistorySlice(
        ctx.history,
        inner.slice("active_history:".length).trim(),
        ctx.charName,
        ctx.userName,
      );
    } else {
      // Not one of ours: pass the whole token through, original spacing intact.
      out += `{{${innerRaw}}}`;
    }

    rest = after.slice(close + 2);
  }

  return out + rest;
}

/**
 * Resolve a `{{file:}}` target, preferring the active-prompt snapshot so the
 * bytes match what the main prompt used this turn, and falling back to the
 * live workspace file for anything not snapshotted.
 *
 * A refused or unreadable path expands to the empty string, matching the
 * "unknown var → empty" degradation elsewhere. It does *not* expand to an
 * error message: the result is fed to an external model, and a message naming
 * the rejected path would echo attacker-chosen text straight into the prompt.
 *
 * The target is confined by {@link resolvePath}, the same boundary the `read`
 * and `write` tools use. Absolute paths, `..` traversal and symlinks pointing
 * out of the workspace all expand to nothing. This is not defense in depth for
 * its own sake — expanded content is handed to an external provider, so an
 * unconfined path is an exfiltration primitive.
 */
function readPromptFile(path: string, ctx: MacroContext): string {
  const warn = ctx.warn ?? (() => {});
  const read = ctx.readFile ?? defaultReadFile;

  try {
    resolvePath(ctx.workspaceDir, path);
  } catch (e) {
    warn(path, e instanceof Error ? e.message : String(e));
    return "";
  }

  // The snapshot holds only the fixed set of prompt-visible root files, so the
  // lookup key can never be attacker-chosen: `normalizePromptVisiblePath`
  // either returns one of those names or nothing at all. A traversal dressed
  // up to look like `SOUL.md` therefore cannot select a different snapshot
  // file — at worst it resolves to the real `SOUL.md`, which was already
  // legitimately readable.
  const visible = normalizePromptVisiblePath(path);
  if (visible !== undefined) {
    const snapshot = read(activePromptFile(ctx.characterDataDir, visible));
    if (snapshot !== undefined) return snapshot;
  }

  // Re-resolve rather than reusing the value above: keeping the confinement
  // check and the path actually opened in one expression means they cannot
  // drift apart.
  const target = resolvePath(ctx.workspaceDir, path);
  const content = read(target);
  if (content === undefined) {
    warn(path, "file unreadable");
    return "";
  }
  return content;
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// ── History transcript ──────────────────────────────────────────────────

/**
 * Render the last `n` messages as a plain `Speaker: text` transcript.
 *
 * Assistant turns are labelled with the character name, user turns with the
 * display name. Empty turns and non-text blocks (thinking, tool calls) are
 * skipped; images are annotated inline.
 *
 * An `n` that does not parse yields the empty string rather than a default or
 * an error. That is the documented degradation, and it matters that it is not
 * "show everything": `{{active_history: all}}` is a plausible thing for a
 * prompt author to write, and it must not silently ship the whole
 * conversation to a cheaper third-party model.
 */
export function renderHistorySlice(
  history: readonly Message[],
  arg: string,
  charName: string,
  userName: string,
): string {
  const n = Math.min(parseCount(arg), MAX_HISTORY_MESSAGES);
  // The `n === 0` arm is redundant with the slice arithmetic below — a start
  // of `length` yields an empty window either way — and is kept only because
  // it states the intent that a zero count means "nothing", not "unbounded".
  if (n === 0 || history.length === 0) return "";

  const start = Math.max(0, history.length - n);
  const lines: string[] = [];
  for (const msg of history.slice(start)) {
    const text = messageDisplayText(msg);
    if (text.trim() === "") continue;
    lines.push(`${speakerLabel(msg.role, charName, userName)}: ${text}`);
  }
  return lines.join("\n");
}

/**
 * Rust's `str::parse::<usize>()`, whose failure the caller maps to `0`.
 *
 * `Number()` is far more permissive: it accepts `-1`, `2.5`, `1e3`, leading
 * and trailing whitespace, and returns `0` for the empty string. Each of those
 * would be a *larger* slice than the Rust produced, so the strict shape is
 * checked explicitly.
 */
function parseCount(arg: string): number {
  if (!/^\d+$/.test(arg)) return 0;
  const n = Number(arg);
  return Number.isSafeInteger(n) ? n : MAX_HISTORY_MESSAGES;
}

function speakerLabel(role: Message["role"], charName: string, userName: string): string {
  switch (role) {
    case "user":
      return userName;
    case "assistant":
      return charName;
    default:
      return "System";
  }
}

/**
 * A readable rendering of one message: the plain `content`, or the joined text
 * blocks when `content` is empty, with an inline note for attached images.
 *
 * Thinking and tool blocks are dropped. A sub-agent gets a transcript of what
 * was *said*, not a replay of the primary model's reasoning or tool traffic —
 * that is the compression the whole feature exists for.
 */
export function messageDisplayText(msg: Message): string {
  let text =
    msg.content.trim() === ""
      ? msg.content_blocks
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n")
      : msg.content;

  const imageCount = msg.images?.length ?? 0;
  if (imageCount > 0) {
    const note = `[${imageCount} image(s)]`;
    text = text.trim() === "" ? note : `${text} ${note}`;
  }
  return text;
}

// ── Tool subset ─────────────────────────────────────────────────────────

/** A tool as the registry describes it, before per-agent rendering. */
export interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
}

/** A tool as it goes out on the wire. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

/** Resolves `mcp__server__*` grants against the connected MCP servers. */
export interface McpMatcher {
  namesMatching: (allowed: readonly string[]) => ToolDefinition[];
}

/**
 * Render a sub-agent's allowed tool list to the outbound `tools` array.
 *
 * Only registered static tools are eligible; unknown names are skipped,
 * because the config layer cannot see the daemon's tool registry and so the
 * filter has to land here.
 *
 * `ask_*` can never appear, and that is structural rather than a check:
 * sub-agent tools are not in the static registry, so a config naming one is
 * simply dropped. The recursion cap and the "no `ask_*` affordance" guarantee
 * both fall out of this single filter, which is why it is worth keeping the
 * eligibility rule to exactly "is it in the registry".
 *
 * Order is stable: static tools in the order the agent listed them, then MCP
 * expansions. A model's tool choice is sensitive to ordering, so a subset that
 * reshuffled between turns would make the sub-agent's behaviour irreproducible.
 */
export function subagentToolSubset(
  allowed: readonly string[],
  registry: readonly RegisteredTool[],
  vars: Map<string, string>,
  renderTemplate: (template: string, vars: Map<string, string>) => string,
  mcp?: McpMatcher,
  onUnknown?: (name: string) => void,
): ToolDefinition[] {
  const defs: ToolDefinition[] = [];

  for (const name of allowed) {
    const def = registry.find((t) => t.name === name);
    if (def === undefined) {
      // MCP names are resolved below; anything else is genuinely unknown.
      if (!name.startsWith("mcp__")) onUnknown?.(name);
      continue;
    }
    defs.push({
      name: def.name,
      description: renderTemplate(def.description, vars),
      parameters: def.parameters,
    });
  }

  if (mcp !== undefined) defs.push(...mcp.namesMatching(allowed));
  return defs;
}

// ── Model resolution ────────────────────────────────────────────────────

/** The subagent-relevant slice of a resolved config. */
export interface SubagentModelDefaults {
  subagent_model?: string;
  model?: string;
}

/**
 * Pick the model a sub-agent runs on: its own setting, else
 * `defaults.subagent_model`, else `defaults.model`.
 *
 * The chain stops there rather than falling through to the active chat model.
 * That is deliberate — the point of delegation is to land on something cheap,
 * and silently inheriting the expensive conversational model would invert the
 * feature's entire purpose while looking like it worked.
 *
 * @returns the model name, or `undefined` when nothing in the chain is set.
 */
export function resolveSubagentModel(
  specModel: string | undefined,
  defaults: SubagentModelDefaults,
): string | undefined {
  return specModel ?? defaults.subagent_model ?? defaults.model;
}

/** The error text for a sub-agent with no model anywhere in its chain. */
export function missingModelMessage(name: string): string {
  return `subagent '${name}' has no model; set subagents.${name}.model or defaults.subagent_model`;
}
