import { readCharacterState } from "../storage/store.ts";
import { readFileSync } from "node:fs";
import { activePromptFile, normalizePromptVisiblePath, resolvePath } from "./workspace_path";
import { wallClockMarker } from "../engine/prompt.ts";
import { hostZone } from "../ledger/zoned.ts";
import type { ContentBlock, Message } from "../engine/types";

export const MAX_HISTORY_MESSAGES = 100;

export interface PromptFileReader {
  read: (path: string) => string | undefined;
}

export type MacroWarn = (path: string, reason: string) => void;

export interface MacroContext {
  characterDataDir: string;
  workspaceDir: string;
  history: readonly Message[];
  charName: string;
  userName: string;
  readFile?: (path: string) => string | undefined;
  warn?: MacroWarn;
}

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
      out += `{{${innerRaw}}}`;
    }

    rest = after.slice(close + 2);
  }

  return out + rest;
}

function readPromptFile(path: string, ctx: MacroContext): string {
  const warn = ctx.warn ?? (() => {});
  const read = ctx.readFile ?? defaultReadFile;

  try {
    resolvePath(ctx.workspaceDir, path);
  } catch (e) {
    warn(path, e instanceof Error ? e.message : String(e));
    return "";
  }

  const visible = normalizePromptVisiblePath(path);
  if (visible !== undefined) {
    const snapshot = ctx.readFile === undefined
      ? readCharacterState(ctx.characterDataDir, `active_prompt/${visible}`)
      : read(activePromptFile(ctx.characterDataDir, visible));
    if (snapshot !== undefined) return snapshot;
  }

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

export function renderHistorySlice(
  history: readonly Message[],
  arg: string,
  charName: string,
  userName: string,
  timeZone: string = hostZone(),
): string {
  const n = Math.min(parseCount(arg), MAX_HISTORY_MESSAGES);
  if (n === 0 || history.length === 0) return "";

  const start = Math.max(0, history.length - n);
  const lines: string[] = [];
  let previousTimestamp: string | undefined;
  for (const msg of history.slice(start)) {
    const text = messageDisplayText(msg);
    if (text.trim() === "") continue;
    const marker = wallClockMarker(previousTimestamp, msg.timestamp, timeZone);
    if (marker !== undefined) lines.push(marker);
    previousTimestamp = msg.timestamp;
    lines.push(`${speakerLabel(msg.role, charName, userName)}: ${text}`);
  }
  return lines.join("\n");
}

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

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface McpMatcher {
  namesMatching: (allowed: readonly string[]) => ToolDefinition[];
}

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

export function missingModelMessage(name: string, character: string | undefined): string {
  const inherit =
    character === undefined
      ? "no character is attached to inherit a chat model from"
      : `${character} has no chat model to inherit`;
  return (
    `subagent '${name}' has no model: subagents.${name}.model and defaults.subagent_model ` +
    `are unset, and ${inherit}`
  );
}
