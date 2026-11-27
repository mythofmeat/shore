import { join } from "node:path";

import { resolveDisplayName } from "../../config/app.ts";
import { MAIN_THREAD, archiveKey } from "../../config/dirs.ts";
import { findEffectiveModel } from "../../config/effective_catalog.ts";
import type { LoadedConfig } from "../../config/loader.ts";
import { toRequestModel } from "../../config/models.ts";
import { configView, pinnedModel, resolveChatModelForCharacter, type FindEffectiveModel } from "../../config/preferences.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../../engine/history_store.ts";
import { deriveContentFromBlocks, normalizeMessage } from "../../engine/message_store.ts";
import { threadChatModel } from "../../engine/threads.ts";
import type { Message } from "../../engine/types.ts";
import { credentialEntry } from "../../handler/tool_context.ts";
import { acceptsCacheTtl } from "../../llm/cache_capability.ts";
import { buildRequestWithProviderKeys, providerOptionsFor, type ResolvedModel } from "../../llm/request.ts";
import { REASONING_OFF, type GenerateResponse, type SidecarRequest } from "../../llm/types.ts";
import { shoreLog } from "../../log.ts";
import { required } from "../../util/required.ts";
import type { SegmentArchiveHook } from "./archive.ts";
import { effectiveConfig, type CompactionRunDeps } from "./run.ts";
import { Texts } from "../../texts/texts.ts";

export const SEGMENT_LABEL_CHARS = 160;

export const LABEL_MESSAGE_BYTES = 1_000;

export const LABEL_CONVERSATION_BYTES = 30_000;

const LABEL_CACHE_TTL = "5m";

const CUT = "…";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

export type SegmentLabelDeps = Pick<CompactionRunDeps, "config" | "env"> & {
  generate: (request: SidecarRequest, model: ResolvedModel, character: string) => Promise<GenerateResponse>;
};

export function labelFromReply(reply: string): string | undefined {
  const line = reply.split("\n").map((each) => each.trim()).find((each) => each !== "");
  return line === undefined ? undefined : shortenLabel(Array.from(line));
}

function shortenLabel(chars: readonly string[]): string {
  if (chars.length <= SEGMENT_LABEL_CHARS) return chars.join("");
  const fits = chars.slice(0, SEGMENT_LABEL_CHARS - 1);
  const lastSpace = chars.slice(0, SEGMENT_LABEL_CHARS).findLastIndex((char) => /\s/.test(char));
  const words = lastSpace === -1 ? fits : chars.slice(0, lastSpace);
  return `${words.join("").trimEnd()}${CUT}`;
}

export function labelConversation(messages: readonly Message[], names: { char: string; user: string }): { text: string; cut: boolean } {
  let cut = false;
  const lines = messages.flatMap((message) => {
    if (message.role === "system" || (message.role === "user" && message.origin === "autonomous")) return [];
    const text = deriveContentFromBlocks(message.content_blocks, false);
    if (text === "") return [];
    const shown = cutMessage(text);
    if (shown !== text) cut = true;
    return [`${message.role === "user" ? names.user : names.char}: ${shown}`];
  });
  const kept = fitConversation(lines);
  return { text: kept.join("\n"), cut: cut || kept.length !== lines.length };
}

function cutMessage(text: string): string {
  if (bytes(text) <= LABEL_MESSAGE_BYTES) return text;
  let room = LABEL_MESSAGE_BYTES;
  const kept: string[] = [];
  for (const char of text) {
    room -= bytes(char);
    if (room < 0) break;
    kept.push(char);
  }
  return `${kept.join("").trimEnd()}${CUT}`;
}

function fitConversation(lines: readonly string[]): string[] {
  const size = (line: string): number => bytes(line) + 1;
  if (lines.reduce((total, line) => total + size(line), 0) <= LABEL_CONVERSATION_BYTES) return [...lines];
  let room = LABEL_CONVERSATION_BYTES - size(CUT);
  let first = 0;
  let end = lines.length;
  for (let fromHead = true; ; fromHead = !fromHead) {
    const line = required(lines[fromHead ? first : end - 1]);
    if (size(line) > room) break;
    room -= size(line);
    if (fromHead) first += 1;
    else end -= 1;
  }
  return [...lines.slice(0, first), CUT, ...lines.slice(end)];
}

export async function prepareLabelCall(
  character: string,
  thread: string,
  messages: readonly Message[],
  deps: SegmentLabelDeps,
  effective: LoadedConfig,
  options: { model?: string } = {},
): Promise<(() => Promise<string | undefined>) | undefined> {
  const names = { char: character, user: resolveDisplayName(effective.app.chat) };
  const conversation = labelConversation(messages, names);
  if (conversation.text === "") return undefined;
  const view = configView(effective);
  const find: FindEffectiveModel = (v, c, n, h) => findEffectiveModel(v, c, n, h);
  if (options.model !== undefined && pinnedModel(view, options.model, find) === undefined) throw new Error(`no model named ${JSON.stringify(options.model)}`);
  const resolved = required(resolveChatModelForCharacter(view, character, find, options.model ?? await threadChatModel(effective.dirs.data, character, thread)));
  const model = toRequestModel(resolved);
  const entry = effective.providers.get(resolved.providerKey);
  const prompt = Texts.of(effective).always("label", { ...names, cut: conversation.cut ? "yes" : undefined }).trim();
  const { reasoning_budget_tokens: _budget, cache_ttl: _ttl, ...unthinking } = model;
  const shortCache = acceptsCacheTtl(model.sdk, model.model_id) ? { cache_ttl: LABEL_CACHE_TTL } : {};
  const { request } = buildRequestWithProviderKeys(model, entry === undefined ? undefined : credentialEntry(entry), {
    messages: [{ role: "user", content: [{ type: "text", text: conversation.text }, { type: "text", text: prompt }] }],
    providerOptions: required(providerOptionsFor({ ...unthinking, ...shortCache, reasoning_effort: REASONING_OFF })),
    replay: "none",
  }, deps.env);
  return async () => {
    const reply = await deps.generate(request, model, character);
    return reply.finish_reason === "refusal" ? undefined : labelFromReply(reply.content);
  };
}

export function labelIfUnlabelled(dataDir: string, character: string, thread: string, segment: number, label: string, replace = false): boolean {
  const key = archiveKey(character, thread);
  const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
  try {
    const existing = store.entries(key).find((entry) => entry.idx === segment)?.label;
    if (existing !== undefined && !replace) return false;
    return store.setLabel(key, segment, label);
  } finally {
    store.close();
  }
}

export class SegmentLabels {
  readonly #deps: () => SegmentLabelDeps;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(deps: () => SegmentLabelDeps) {
    this.#deps = deps;
  }

  readonly hook: SegmentArchiveHook = async ({ archiveKey: key, archived }) => {
    const [character = "", thread = MAIN_THREAD] = key.split("/");
    try {
      const resolved = this.#deps();
      const effective = effectiveConfig(character, resolved.config);
      if (!effective.app.compaction.label_segments) return undefined;
      const messages = archived.map((line) => normalizeMessage(JSON.parse(line) as Message));
      const ask = await prepareLabelCall(character, thread, messages, resolved, effective);
      if (ask === undefined) return undefined;
      return (segment) => {
        const labelling = ask().then((label) => {
          if (label !== undefined) labelIfUnlabelled(effective.dirs.data, character, thread, segment, label);
        }).catch((error: unknown) => {
          shoreLog.warn(`shore: segment ${String(segment)} of ${key} was left unlabelled: ${String(error)}`);
        });
        this.#pending = Promise.all([this.#pending, labelling]);
      };
    } catch (error) {
      shoreLog.warn(`shore: the newest segment of ${key} will be left unlabelled: ${String(error)}`);
      return undefined;
    }
  };

  async settled(): Promise<void> {
    await this.#pending;
  }
}
