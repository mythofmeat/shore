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
import { resolveDisplayName, toolGrants, type HeartbeatConfig } from "../config/app.ts";
import { characterDataDir, resolvePromptTemplate } from "../config/dirs.ts";
import { credentialEntry, type ToolConversation } from "../handler/tool_context.ts";
import { buildChatShapeRequestFromDisk } from "../handler/context.ts";
import { agoPhrase, formatWallClock } from "../engine/prompt.ts";
import { readThreadsIndex, threadActivities, threadChatModel } from "../engine/threads.ts";
import type { Message } from "../engine/types.ts";
import { hostZone } from "../ledger/zoned.ts";
import { buildRequestWithProviderKeys, parseDurationMs } from "../llm/request.ts";
import { applyDeferredEdits } from "../memory/deferred_edits.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import type { SidecarRequest } from "../llm/types.ts";
import { DEFAULT_HEARTBEAT_TEMPLATE, renderHeartbeatPrompt } from "./heartbeat_shape.ts";
import { HEARTBEAT_TIME_LIMIT_MS, HEARTBEAT_WRAP_UP_MS } from "./heartbeat_loop.ts";
import { HEARTBEAT_OPENER, homeDigest, readHomeThrough, type HomeReader } from "./heartbeat_thread.ts";
import type { RebuildDeps } from "../cache/rebuild.ts";

const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;
const DEFAULT_CACHE_TTL_MS = 3_600_000;

function cacheTtlMs(model: ResolvedModel): number {
  return (model.cacheTtl === undefined ? undefined : parseDurationMs(model.cacheTtl)) ?? DEFAULT_CACHE_TTL_MS;
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

export function heartbeatModel(config: LoadedConfig, character: string): ResolvedModel | undefined {
  const view = configView(config);
  const configuredName = view.app.defaults.backgroundModelName("heartbeat");
  if (configuredName === undefined) return undefined;

  try {
    findEffectiveModel(view, config.dirs.cache, configuredName, true);
  } catch (e) {
    shoreLog.warn(
      `shore: heartbeat model "${configuredName}" not found in catalog for ${character}; ` +
        `keeping chat model: ${String(e)}`,
    );
    return undefined;
  }

  return resolveBackgroundModel(view, "heartbeat", character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
}

export function applyHeartbeatModelOverride(
  request: SidecarRequest,
  config: LoadedConfig,
  character: string,
  deps: HeartbeatModelDeps = {},
  resolved: ResolvedModel | undefined = heartbeatModel(config, character),
): HeartbeatModelChoice {
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

export async function lastWroteNote(
  dataDir: string,
  character: string,
  heartbeat: string,
  home: string,
  userName: string,
  nowMs: number,
): Promise<string | undefined> {
  const index = await readThreadsIndex(dataDir, character);
  if (index === undefined) return undefined;
  const threads = index.threads.filter((thread) => thread.id !== heartbeat);
  const activity = await threadActivities(dataDir, character, threads.map((thread) => thread.id));
  let latest: { id: string; label: string | undefined; at: number } | undefined;
  for (const thread of threads) {
    const at = Date.parse(activity.get(thread.id)?.last_user ?? "");
    if (Number.isNaN(at) || (latest !== undefined && at <= latest.at)) continue;
    latest = { id: thread.id, label: thread.label, at };
  }
  if (latest === undefined) return undefined;
  const ago = agoPhrase(Math.max(0, (nowMs - latest.at) / 1000));
  if (latest.id === home) return `[${userName} last wrote to you ${ago}, in your home thread "${home}".]`;
  const name = latest.label === undefined ? `"${latest.id}"` : `"${latest.id}" (${latest.label})`;
  return `[${userName} last wrote to you ${ago}, in the side thread ${name}, which isn't shown here.]`;
}

export interface HeartbeatCutOff {
  at: number;
  rounds: number;
  sent: boolean;
}

export function cutOffNote(cutOff: HeartbeatCutOff, userName: string, timeZone: string): string {
  const rounds = cutOff.rounds === 1 ? "1 round" : `${String(cutOff.rounds)} rounds`;
  const sent = cutOff.sent
    ? `The message it had already written was still sent to ${userName}.`
    : `Nothing from it was sent to ${userName}.`;
  return `[Your last heartbeat reached its ${String(HEARTBEAT_TIME_LIMIT_MS / 60_000)}-minute limit and was stopped at ` +
    `${formatWallClock(cutOff.at, timeZone)}, after ${rounds}, before it had finished. ${sent} ` +
    "Whatever it had already changed with its tools is still in place.]";
}

export interface PrepareHeartbeatDeps {
  rebuild: RebuildDeps;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeZone?: string;
  cutOff?: HeartbeatCutOff;
  newId?: () => string;
}

export interface HeartbeatConversation {
  thread: string;
  home: string;
  history: HomeReader;
  homeThread: HomeReader;
}

export interface PreparedHeartbeat extends ToolConversation {
  request: SidecarRequest;
  opener: Message;
  instructions: Message;
  messageBudget: number;
  modelId: string;
  maxToolIterations: number | undefined;
  override: ResolvedModel | undefined;
}

export async function prepareHeartbeatRequest(
  character: string,
  config: LoadedConfig,
  conversation: HeartbeatConversation,
  deps: PrepareHeartbeatDeps,
): Promise<PreparedHeartbeat | undefined> {
  const { thread, home } = conversation;
  const resolved = resolveChatModelForCharacter(
    configView(config),
    character,
    (v, c, n, h) => findEffectiveModel(v, c, n, h),
    await threadChatModel(config.dirs.data, character, thread),
  );
  if (resolved === undefined) {
    shoreLog.info(`shore: heartbeat skipping tick for ${character} (no chat model resolves)`);
    return undefined;
  }

  const nowMs = deps.now?.() ?? Date.now();
  const timeZone = deps.timeZone ?? hostZone();
  const userName = resolveDisplayName(config.app.defaults, deps.env);
  const characterDir = characterDataDir(config.dirs.data, character);
  const history = conversation.history.messages();
  const archived = conversation.history.segments().segmentCount();
  const since = history.length === 0 && archived === 0 ? undefined : readHomeThrough(characterDir);
  const configured = heartbeatModel(config, character);
  const maxToolIterations = (configured ?? resolved).maxToolIterations;
  const lastAt = Date.parse(history.at(-1)?.timestamp ?? "");
  if (!Number.isNaN(lastAt) && nowMs - lastAt >= cacheTtlMs(configured ?? resolved)) {
    try {
      await applyDeferredEdits(characterDir, characterWorkspace(config, character), thread);
    } catch (e) {
      shoreLog.warn(`shore: could not refresh the heartbeat thread's prompt files for ${character} after a pause: ${String(e)}`);
    }
  }
  const template =
    resolvePromptTemplate(config.dirs.config, character, "heartbeat.md") ??
    DEFAULT_HEARTBEAT_TEMPLATE;
  const rendered = renderHeartbeatPrompt(template, {
    now: formatWallClock(nowMs, timeZone),
    userName,
    defaultInterval: fallbackIntervalPhrase(defaultWakeSecs(config.app.behavior.autonomy.heartbeat)),
    timeLimit: fallbackIntervalPhrase(BigInt(HEARTBEAT_TIME_LIMIT_MS / 1000)),
    wrapUpAfter: fallbackIntervalPhrase(BigInt((HEARTBEAT_TIME_LIMIT_MS - HEARTBEAT_WRAP_UP_MS) / 1000)),
    maxRounds: maxToolIterations,
  });
  const wrote = await lastWroteNote(config.dirs.data, character, thread, home, userName, nowMs).catch(() => undefined);
  const cutOff = deps.cutOff === undefined ? undefined : cutOffNote(deps.cutOff, userName, timeZone);
  const newId = deps.newId ?? (() => `m_${crypto.randomUUID()}`);
  const timestamp = new Date(nowMs).toISOString();
  const note = (role: "user" | "system", text: string): Message => ({
    msg_id: newId(),
    role,
    origin: "autonomous",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp,
  });
  const opener = note("user", `${HEARTBEAT_OPENER}\n\n${await homeDigest(conversation.homeThread, home, since, userName, timeZone)}`);
  const instructions = note("system", [cutOff, wrote, rendered].filter((part) => part !== undefined).join("\n\n"));
  const messages = [...history, opener, instructions];

  let built: Awaited<ReturnType<typeof buildChatShapeRequestFromDisk>>;
  try {
    built = await buildChatShapeRequestFromDisk(character, characterDir, config, resolved, messages, archived > 0, {
      mcpToolDefs: deps.rebuild.mcpRegistry.toolDefsFiltered(toolGrants(config.app.tools)),
      thread,
      activeConversation: true,
      timeZone,
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });
  } catch (e) {
    shoreLog.warn(`shore: heartbeat for ${character} could not build its request: ${String(e)}`);
    return undefined;
  }

  const { request, override } = applyHeartbeatModelOverride(
    built.request,
    config,
    character,
    deps.env === undefined ? {} : { env: deps.env },
    configured,
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

  return {
    request,
    opener,
    instructions,
    thread,
    conversation: messages,
    messageBudget: built.messageBudget,
    modelId: (override ?? resolved).modelId,
    maxToolIterations: (override ?? resolved).maxToolIterations,
    override,
  };
}
