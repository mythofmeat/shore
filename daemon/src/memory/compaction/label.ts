import labelPromptRaw from "../../../prompts/memory/compaction/label.md" with { type: "text" };
import { join } from "node:path";

import { resolveDisplayName, toolGrants } from "../../config/app.ts";
import { MAIN_THREAD, archiveKey, resolvePromptTemplate } from "../../config/dirs.ts";
import { findEffectiveModel } from "../../config/effective_catalog.ts";
import type { LoadedConfig } from "../../config/loader.ts";
import { toRequestModel } from "../../config/models.ts";
import { configView, resolveChatModelForCharacter } from "../../config/preferences.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../../engine/history_store.ts";
import { normalizeMessage } from "../../engine/message_store.ts";
import type { PriorContext } from "../../engine/segments.ts";
import { threadChatModel } from "../../engine/threads.ts";
import type { Message } from "../../engine/types.ts";
import { credentialEntry } from "../../handler/tool_context.ts";
import { ToolLoopStop } from "../../llm/tool_loop_control.ts";
import { shoreLog } from "../../log.ts";
import { rustLines } from "../lines.ts";
import type { SegmentArchiveHook } from "./archive.ts";
import { RealCompactionLlm } from "./llm.ts";
import { buildFinalMessage } from "./manager.ts";
import { stripOneTrailingNewline } from "./prompts.ts";
import { effectiveConfig, resolveChatRequest, type CompactionRunDeps } from "./run.ts";

export const DEFAULT_LABEL_PROMPT: string = stripOneTrailingNewline(labelPromptRaw);

export const SEGMENT_LABEL_CHARS = 60;

export type SegmentLabelDeps = Pick<CompactionRunDeps, "config" | "generate" | "tools" | "env" | "signal">;

export function labelFromReply(reply: string): string | undefined {
  const line = reply.split("\n").map((each) => each.trim()).find((each) => each !== "");
  return line === undefined ? undefined : Array.from(line).slice(0, SEGMENT_LABEL_CHARS).join("");
}

export async function prepareLabelCall(
  character: string,
  thread: string,
  messages: readonly Message[],
  deps: SegmentLabelDeps,
  effective: LoadedConfig,
  options: { prior?: PriorContext; model?: string } = {},
): Promise<() => Promise<string | undefined>> {
  const view = configView(effective);
  const model = options.model === undefined
    ? resolveChatModelForCharacter(view, character, (v, c, n, h) => findEffectiveModel(v, c, n, h), await threadChatModel(effective.dirs.data, character, thread))
    : findEffectiveModel(view, effective.dirs.cache, options.model, true);
  if (model === undefined) throw new Error("no chat model is configured");
  const chatRequest = await resolveChatRequest(character, thread, messages, effective,
    deps.tools?.mcpToolDefs?.(toolGrants(effective.app.tools)) ?? [], deps.env, options.prior, model);
  const entry = effective.providers.get(model.providerKey);
  const llm = new RealCompactionLlm({
    model: toRequestModel(model),
    character,
    generate: deps.generate,
    cacheDir: effective.dirs.cache,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(entry === undefined ? {} : { providerEntry: credentialEntry(entry) }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  const template = resolvePromptTemplate(effective.dirs.config, character, "label.md") ?? DEFAULT_LABEL_PROMPT;
  const request = llm.buildInitialRequest(buildFinalMessage(template, character, resolveDisplayName(effective.app.defaults)).trim(), chatRequest);
  return async () => {
    const reply = await llm.generate(request, { messages: [], runTool: () => Promise.reject(new ToolLoopStop()), recordTurn: () => {} });
    return reply.finish_reason === "tool_use" ? undefined : labelFromReply(reply.content);
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
  readonly #pending = new Set<Promise<void>>();

  constructor(deps: () => SegmentLabelDeps) {
    this.#deps = deps;
  }

  readonly hook: SegmentArchiveHook = async ({ archiveKey: key, activeContent }) => {
    const [character = "", thread = MAIN_THREAD] = key.split("/");
    try {
      const resolved = this.#deps();
      const effective = effectiveConfig(character, resolved.config);
      if (!effective.app.memory.compaction.label_segments) return undefined;
      const messages = rustLines(activeContent).filter((line) => line.trim() !== "").map((line) => normalizeMessage(JSON.parse(line) as Message));
      const ask = await prepareLabelCall(character, thread, messages, resolved, effective);
      return (segment) => {
        const labelling = ask().then((label) => {
          if (label !== undefined) labelIfUnlabelled(effective.dirs.data, character, thread, segment, label);
        }).catch((error: unknown) => {
          shoreLog.warn(`shore: segment ${String(segment)} of ${key} was left unlabelled: ${String(error)}`);
        }).finally(() => {
          this.#pending.delete(labelling);
        });
        this.#pending.add(labelling);
      };
    } catch (error) {
      shoreLog.warn(`shore: the newest segment of ${key} will be left unlabelled: ${String(error)}`);
      return undefined;
    }
  };

  async settled(): Promise<void> {
    await Promise.all(this.#pending);
  }
}
