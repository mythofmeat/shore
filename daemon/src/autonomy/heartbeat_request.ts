import { join } from "node:path";
import { usageConfigView } from "../ledger/budget.ts";
import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import {
  configView,
  resolveBackgroundModel,
  resolveChatModelForCharacter,
} from "../config/preferences.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { resolvedReplayPriorThinking, toRequestModel, type ResolvedModel } from "../config/models.ts";
import { resolveDisplayName, type HeartbeatConfig } from "../config/app.ts";
import { resolvePromptTemplate } from "../config/dirs.ts";
import { credentialEntry, type ToolConversation } from "../handler/tool_context.ts";
import { formatWallClock, heartbeatMarker } from "../engine/prompt.ts";
import { homeThreadOf, readThreadsIndex, threadActivities, threadChatModel } from "../engine/threads.ts";
import { hostZone } from "../ledger/zoned.ts";
import { buildRequestWithProviderKeys, pushInlineSystem } from "../llm/request.ts";
import type { SidecarRequest } from "../llm/types.ts";
import { DEFAULT_HEARTBEAT_TEMPLATE, renderHeartbeatPrompt } from "./heartbeat_shape.ts";
import type { LastRequestCache } from "../cache/last_request.ts";
import { rebuildRequestFromDisk, type RebuildDeps } from "../cache/rebuild.ts";

const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;

function copyForTick(request: SidecarRequest): SidecarRequest {
  const copy: SidecarRequest = { ...request, messages: [...request.messages] };
  if (copy.context !== undefined) {
    const { rid: _rid, ...rest } = copy.context;
    copy.context = { ...rest, call_type: "heartbeat" };
  }
  return copy;
}

export function fallbackIntervalPhrase(secs: bigint): string {
  if (secs >= SECONDS_PER_HOUR && secs % SECONDS_PER_HOUR === 0n) {
    const hours = secs / SECONDS_PER_HOUR;
    return hours === 1n ? "1 hour" : `${hours} hours`;
  }
  return `${secs / SECONDS_PER_MINUTE} minutes`;
}

function defaultWakeSecs(heartbeat: HeartbeatConfig): bigint {
  const secs = heartbeat.default_interval.asSecs();
  const floor = heartbeat.min_interval.asSecs();
  const ceiling = heartbeat.max_interval.asSecs();
  return secs < floor ? floor : secs > ceiling ? ceiling : secs;
}

export interface HeartbeatModelChoice {
  request: SidecarRequest;
  override: ResolvedModel | undefined;
}

export interface HeartbeatModelDeps {
  env?: NodeJS.ProcessEnv;
}

export function applyHeartbeatModelOverride(
  request: SidecarRequest,
  config: LoadedConfig,
  character: string,
  deps: HeartbeatModelDeps = {},
): HeartbeatModelChoice {
  const view = configView(config);
  const configuredName = view.app.defaults.backgroundModelName("heartbeat");
  if (configuredName === undefined) return { request, override: undefined };

  try {
    findEffectiveModel(view, config.dirs.cache, configuredName, true);
  } catch (e) {
    shoreLog.warn(
      `shore: heartbeat model "${configuredName}" not found in catalog for ${character}; ` +
        `keeping chat model: ${String(e)}`,
    );
    return { request, override: undefined };
  }

  const resolved = resolveBackgroundModel(view, "heartbeat", character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (resolved === undefined) return { request, override: undefined };

  const entry = config.providers.get(resolved.providerKey);
  try {
    const built = buildRequestWithProviderKeys(
      toRequestModel(resolved),
      entry === undefined ? undefined : credentialEntry(entry),
      {
        messages: request.messages,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),
      },
      deps.env,
    );
    shoreLog.info(
      `shore: heartbeat for ${character} using configured model ${resolved.name} (${built.request.model})`,
    );
    return { request: built.request, override: resolved };
  } catch (e) {
    shoreLog.warn(
      `shore: heartbeat could not build a request on ${resolved.name} for ${character}, ` +
        `falling back to the chat model: ${String(e)}`,
    );
    return { request, override: undefined };
  }
}

const ELSEWHERE_WINDOW_MS = 86_400_000;

function sinceText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return minutes === 1 ? "a minute ago" : `${String(minutes)} minutes ago`;
  return `${String(Math.round(minutes / 60))} hours ago`;
}

export async function elsewhereNote(
  dataDir: string,
  character: string,
  home: string,
  userName: string,
  nowMs: number,
): Promise<string | undefined> {
  const index = await readThreadsIndex(dataDir, character);
  if (index === undefined) return undefined;
  const activity = await threadActivities(dataDir, character, index.threads.map((thread) => thread.id));
  const lastIn = (id: string) => Date.parse(activity.get(id)?.last_user ?? "");
  const homeAt = lastIn(home);
  let latest: { id: string; label: string | undefined; at: number } | undefined;
  for (const thread of index.threads) {
    if (thread.id === home) continue;
    const at = lastIn(thread.id);
    if (Number.isNaN(at) || (latest !== undefined && at <= latest.at)) continue;
    latest = { id: thread.id, label: thread.label, at };
  }
  if (latest === undefined || nowMs - latest.at > ELSEWHERE_WINDOW_MS) return undefined;
  if (!Number.isNaN(homeAt) && homeAt >= latest.at) return undefined;
  const name = latest.label === undefined ? `"${latest.id}"` : `"${latest.id}" (${latest.label})`;
  return `[${userName} last wrote to you ${sinceText(nowMs - latest.at)}, in the side thread ${name}. That conversation isn't shown here, so a quiet home thread doesn't mean ${userName} has been away.]`;
}

export interface PrepareHeartbeatDeps {
  thread?: string;
  cache: LastRequestCache;
  rebuild: RebuildDeps;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeZone?: string;
}

export interface PreparedHeartbeat extends ToolConversation {
  request: SidecarRequest;
  maxToolIterations: number | undefined;
  override: ResolvedModel | undefined;
}

export async function prepareHeartbeatRequest(
  character: string,
  config: LoadedConfig,
  deps: PrepareHeartbeatDeps,
): Promise<PreparedHeartbeat | undefined> {
  const thread = deps.thread ?? await homeThreadOf(config.dirs.data, character);
  const rebuilt = await rebuildRequestFromDisk(
    character,
    config.dirs.data,
    config,
    { ...deps.rebuild, thread },
  );
  if (rebuilt === undefined) {
    shoreLog.info(
      `shore: heartbeat skipping tick for ${character} (conversation mid-turn or model unresolved)`,
    );
    return undefined;
  }
  const source = rebuilt.request;
  if (deps.cache.get(character) === undefined) {
    deps.cache.set(character, source, {
      intervalMs: rebuilt.keepalive_interval_ms,
      pings: rebuilt.keepalive_pings,
    }, false, thread);
  }

  const { request, override } = applyHeartbeatModelOverride(
    copyForTick(source),
    config,
    character,
    deps.env === undefined ? {} : { env: deps.env },
  );

  request.context = {
    ...request.context,
    ledger: join(config.dirs.data, "shore.db"),
    usage: usageConfigView(config.app.usage),
    character,
    thread,
    call_type: "heartbeat",
    thinking_enabled: request.context?.thinking_enabled ?? false,
  };

  const maxToolIterations =
    override !== undefined
      ? override.maxToolIterations
      : resolveChatModelForCharacter(
          configView(config),
          character,
          (v, c, n, h) => findEffectiveModel(v, c, n, h),
          await threadChatModel(config.dirs.data, character, thread),
        )?.maxToolIterations;

  const nowMs = deps.now?.() ?? Date.now();
  const timeZone = deps.timeZone ?? hostZone();
  const template =
    resolvePromptTemplate(config.dirs.config, character, "heartbeat.md") ??
    DEFAULT_HEARTBEAT_TEMPLATE;
  const userName = resolveDisplayName(config.app.defaults, deps.env);
  const rendered = renderHeartbeatPrompt(
    template,
    formatWallClock(nowMs, timeZone),
    userName,
    fallbackIntervalPhrase(defaultWakeSecs(config.app.behavior.autonomy.heartbeat)),
  );
  const elsewhere = await elsewhereNote(config.dirs.data, character, thread, userName, nowMs).catch(() => undefined);
  const prompt = elsewhere === undefined ? rendered : `${elsewhere}\n\n${rendered}`;

  const marker = heartbeatMarker(nowMs, config.app.behavior.user_message_timestamps, timeZone);
  request.messages.push({ role: "user", content: [{ type: "text", text: marker }] });
  pushInlineSystem(request, prompt);

  return {
    request,
    thread: rebuilt.thread,
    conversation: rebuilt.conversation,
    maxToolIterations,
    override,
  };
}
