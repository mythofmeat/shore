import { createHash } from "node:crypto";
import { join } from "node:path";

import { shoreLog } from "../../log.ts";
import type { HeartbeatEventKind } from "../../autonomy/heartbeat_log.ts";
import { runHeartbeatToolLoop, type HeartbeatToolResult, type TranscriptRound } from "../../autonomy/heartbeat_loop.ts";
import { applyHeartbeatModelOverride, backgroundTaskModel, fallbackIntervalPhrase } from "../../autonomy/heartbeat_request.ts";
import { resolveDisplayName, toolGrants, type ToolsConfig } from "../../config/app.ts";
import { activeJsonlIn, characterDataDir, resolvePromptTemplate, threadDataDir } from "../../config/dirs.ts";
import { findEffectiveModel } from "../../config/effective_catalog.ts";
import type { LoadedConfig } from "../../config/loader.ts";
import { applyBackgroundSettings, configView, resolveChatModelForCharacter } from "../../config/preferences.ts";
import { formatWallClock } from "../../engine/prompt.ts";
import { heartbeatThread, homeThreadOf, readThreadsIndex, threadChatModel } from "../../engine/threads.ts";
import type { ContentBlock, Message } from "../../engine/types.ts";
import { buildChatShapeRequestFromDisk } from "../../handler/context.ts";
import { usageConfigView, type CallBlock } from "../../ledger/budget.ts";
import { budgetBlockFor } from "../../ledger/gate.ts";
import { hostZone } from "../../ledger/zoned.ts";
import { describeError } from "../../llm/errors.ts";
import type { GenerateResponse, SidecarRequest, ToolDefinition } from "../../llm/types.ts";
import { truncateSummary } from "../../notifications.ts";
import { readDurable } from "../../storage/files.ts";
import { characterWorkspace } from "../../tools/character_workspace.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import { gitChangesBetween, gitHead, gitPushWorkspace } from "../../tools/workspace.ts";
import { loadCanonicalPromptFile } from "../deferred_edits.ts";
import { conversationLines, conversationsSince } from "./manifest.ts";
import { DEFAULT_DREAM_TEMPLATE, DREAM_OPENER, dreamCutOffNote, dreamWrapUpText, renderDreamPrompt } from "./prompt.ts";
import { clearWorkspaceReads, mostReadLines, workspaceReadCounts } from "./reads.ts";
import { appendDreamRecord, lastDream, lastHead, type StoredDream } from "./records.ts";

export const DREAM_TOOL_THREAD = "@dream";

export const DREAM_CALL_TYPE = "dreaming";

const DREAM_NOTES_FILE = "DREAMS.md";

const LEFT_OUT_TOOLS = new Set(["set_next_wake", "start_thread", "edit_thread", "list_threads", "generate_image", "save_picture"]);

const MOST_READ = 15;

const NOTES_CHARS = 16_000;

const SUMMARY_CHARS = 4_000;

const DREAM_WRAP_UP_ROUNDS = 8;

const MAX_WRAP_UP_MS = 10 * 60_000;

export type DreamPassOutcome = "finished" | "cut_off" | "failed" | "skipped";

export interface DreamPass {
  outcome: DreamPassOutcome;
  startedAt: number;
  events: { kind: HeartbeatEventKind; detail: string }[];
  record?: StoredDream;
}

export interface DreamPassDeps {
  mcpToolDefs: (grants: readonly string[]) => ToolDefinition[];
  generate: (request: SidecarRequest, phase: ToolPhase, signal: AbortSignal) => Promise<GenerateResponse | undefined>;
  dispatch: (config: LoadedConfig, name: string, input: unknown, toolUseId: string | undefined, tools: readonly ToolDefinition[] | undefined) => Promise<HeartbeatToolResult>;
  recordTranscript?: (round: TranscriptRound) => void;
  refreshHome?: () => Promise<void>;
  budgetBlockFor?: (request: SidecarRequest) => CallBlock | undefined;
  push?: (config: LoadedConfig, character: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeZone?: string;
  forced?: boolean;
}

export function dreamToolsConfig(tools: ToolsConfig, chosen: readonly string[] | undefined): ToolsConfig {
  return {
    ...tools,
    enabled_tools: chosen === undefined
      ? tools.enabled_tools.filter((name) => !LEFT_OUT_TOOLS.has(name) && !name.startsWith("mcp__"))
      : [...chosen],
    enabled_mcp: [],
  };
}

export function dreamConfig(config: LoadedConfig): LoadedConfig {
  return {
    ...config,
    app: { ...config.app, tools: dreamToolsConfig(config.app.tools, config.app.memory.dreaming.tools) },
  };
}

export function dreamLimits(config: LoadedConfig): { limitMs: number; wrapUpMs: number } {
  const limitMs = Number(config.app.memory.dreaming.time_limit.asMillisExact());
  return { limitMs, wrapUpMs: Math.min(MAX_WRAP_UP_MS, Math.floor(limitMs / 6)) };
}

function counted(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${String(n)} ${noun}s`;
}

function phrase(ms: number): string {
  return fallbackIntervalPhrase(BigInt(Math.trunc(ms / 1000)));
}

function homeDigest(dataDir: string, character: string, home: string): string {
  try {
    return createHash("sha256").update(readDurable(activeJsonlIn(threadDataDir(dataDir, character, home)))).digest("hex");
  } catch {
    return "";
  }
}

function cappedNotes(notes: string | undefined): string | undefined {
  const trimmed = notes?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  if (trimmed.length <= NOTES_CHARS) return trimmed;
  return `${trimmed.slice(0, NOTES_CHARS).trimEnd()}\n\n[Cut here: read ${DREAM_NOTES_FILE} for the rest.]`;
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
}

function note(text: string, timestamp: string, role: "user" | "system"): Message {
  return {
    msg_id: `m_${crypto.randomUUID()}`,
    role,
    origin: "autonomous",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp,
  };
}

export async function defaultPush(config: LoadedConfig, character: string): Promise<boolean> {
  return await gitPushWorkspace(characterWorkspace(config, character));
}

export async function runDreamPass(
  character: string,
  config: LoadedConfig,
  sinceMs: number,
  deps: DreamPassDeps,
): Promise<DreamPass> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const events: DreamPass["events"] = [];
  const failed = (detail: string): DreamPass => {
    events.push({ kind: "dream_failed", detail });
    return { outcome: "failed", startedAt, events };
  };
  const dataDir = config.dirs.data;
  const characterDir = characterDataDir(dataDir, character);
  const timeZone = deps.timeZone ?? hostZone();
  const userName = resolveDisplayName(config.app.defaults, deps.env);
  const workspace = characterWorkspace(config, character);
  const dreaming = config.app.memory.dreaming;

  const home = await homeThreadOf(dataDir, character);
  const heartbeat = heartbeatThread(await readThreadsIndex(dataDir, character));
  const conversations = await conversationsSince(dataDir, character, sinceMs, new Set(heartbeat === undefined ? [] : [heartbeat]));
  if (conversations.length === 0 && deps.forced !== true) {
    shoreLog.info(`shore: dream for ${character} skipped, nothing has been archived since ${new Date(sinceMs).toISOString()}`);
    return { outcome: "skipped", startedAt, events };
  }

  const chat = resolveChatModelForCharacter(
    configView(config),
    character,
    (v, c, n, h) => findEffectiveModel(v, c, n, h),
    await threadChatModel(dataDir, character, home),
  );
  if (chat === undefined) return failed("Dream skipped: no chat model resolves");
  const settled = applyBackgroundSettings(dataDir, character, "dreaming", chat);
  const resolved = dreaming.system_prompt === undefined ? settled : { ...settled, systemPrompt: dreaming.system_prompt };
  const configured = backgroundTaskModel(config, character, "dreaming");

  const headBefore = await gitHead(workspace).catch(() => undefined);
  const previous = lastDream(characterDir);
  const previousHead = lastHead(characterDir);
  const { limitMs, wrapUpMs } = dreamLimits(config);
  const timeLimit = phrase(limitMs);
  const reads = mostReadLines(workspaceReadCounts(characterDir), MOST_READ);
  const template = resolvePromptTemplate(config.dirs.config, character, "dream.md") ?? DEFAULT_DREAM_TEMPLATE;
  const rendered = renderDreamPrompt(template, {
    now: formatWallClock(startedAt, timeZone),
    userName,
    characterName: character,
    lastDream: previous === undefined ? undefined : formatWallClock(Date.parse(previous.started_at), timeZone),
    conversations: conversationLines(
      conversations,
      userName,
      previousHead === undefined ? `--since=${new Date(sinceMs).toISOString()}` : `${previousHead.slice(0, 7)}..HEAD`,
    ),
    reads: reads.length === 0 ? undefined : reads.join("\n"),
    notes: cappedNotes(await loadCanonicalPromptFile(workspace, DREAM_NOTES_FILE).catch(() => undefined)),
    timeLimit,
    wrapUpAfter: phrase(limitMs - wrapUpMs),
  });
  const cutOff = previous?.outcome === "cut_off"
    ? dreamCutOffNote(Date.parse(previous.started_at), timeLimit, timeZone)
    : undefined;
  const timestamp = new Date(startedAt).toISOString();
  const messages = [
    note(DREAM_OPENER, timestamp, "user"),
    note([cutOff, rendered].filter((part) => part !== undefined).join("\n\n"), timestamp, "system"),
  ];

  const scoped = dreamConfig(config);
  let built: Awaited<ReturnType<typeof buildChatShapeRequestFromDisk>>;
  try {
    built = await buildChatShapeRequestFromDisk(character, characterDir, scoped, resolved, messages, false, {
      mcpToolDefs: deps.mcpToolDefs(toolGrants(scoped.app.tools)),
      canonicalPromptFiles: true,
      activeConversation: true,
      timeZone,
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });
  } catch (e) {
    shoreLog.warn(`shore: dream for ${character} could not build its request: ${String(e)}`);
    return failed(`Dream could not build its request — ${truncateSummary(String(e), 200)}`);
  }
  const { request, override } = applyHeartbeatModelOverride(
    built.request,
    scoped,
    character,
    deps.env === undefined ? {} : { env: deps.env },
    configured,
    "dream",
  );
  request.context = {
    ...request.context,
    ledger: join(dataDir, "shore.db"),
    usage: usageConfigView(config.app.usage),
    character,
    call_type: DREAM_CALL_TYPE,
    thinking_enabled: request.context?.thinking_enabled ?? false,
  };

  const blocked = (deps.budgetBlockFor ?? budgetBlockFor)(request);
  if (blocked !== undefined) return failed(`Dream paused before it started — ${blocked.summary}`);

  events.push({
    kind: "dream_started",
    detail: `Dream started over ${counted(conversations.length, "conversation")}`,
  });
  const homeBefore = homeDigest(dataDir, character, home);
  let summary = "";
  const loop = await runHeartbeatToolLoop(request, {
    character,
    generate: deps.generate,
    dispatch: (name, input, toolUseId, tools) => deps.dispatch(scoped, name, input, toolUseId, tools),
    note: (detail) => {
      if (!detail.startsWith("Tool: ")) events.push({ kind: "tool_use", detail });
    },
    ...(deps.recordTranscript === undefined ? {} : { recordTranscript: deps.recordTranscript }),
    persist: async (round) => {
      if (round.role !== "assistant") return;
      const text = textOf(round.blocks);
      if (text !== "") summary = text;
    },
    wrapUpGrace: DREAM_WRAP_UP_ROUNDS,
    maxToolIterations: (override ?? resolved).maxToolIterations,
    timeLimitMs: limitMs,
    wrapUpMs,
    wrapUpText: dreamWrapUpText,
    callTypes: [DREAM_CALL_TYPE, DREAM_CALL_TYPE],
  });

  const headAfter = await gitHead(workspace).catch(() => undefined);
  const changes = await gitChangesBetween(workspace, headBefore, headAfter).catch(() => ({ commits: 0, files: [] }));
  let pushed: boolean | undefined;
  if (config.app.memory.git_push && changes.commits > 0) {
    try {
      pushed = await (deps.push ?? defaultPush)(config, character);
    } catch (e) {
      shoreLog.warn(`shore: could not push ${character}'s workspace after a dream: ${String(e)}`);
      pushed = false;
    }
  }

  const outcome: DreamPassOutcome = loop.timedOut === true ? "cut_off" : loop.failedRound === undefined ? "finished" : "failed";
  const error = outcome === "failed"
    ? truncateSummary(loop.failure === undefined ? `the model call failed on round ${String(loop.failedRound ?? 0)}` : describeError(loop.failure), 300)
    : undefined;
  const record: StoredDream = {
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date(now()).toISOString(),
    outcome,
    conversations: conversations.length,
    commits: changes.commits,
    files: changes.files,
    ...(pushed === undefined ? {} : { pushed }),
    ...(summary === "" ? {} : { summary: truncateSummary(summary, SUMMARY_CHARS) }),
    ...(error === undefined ? {} : { error }),
    ...(headAfter === undefined ? {} : { head: headAfter }),
  };
  appendDreamRecord(characterDir, record);
  if (outcome === "finished") clearWorkspaceReads(characterDir);

  const counts = `${counted(changes.commits, "commit")}, ${counted(changes.files.length, "file")}` +
    (pushed === undefined ? "" : pushed ? ", pushed" : ", not pushed");
  events.push(
    outcome === "failed"
      ? { kind: "dream_failed", detail: `Dream failed — ${error ?? "unknown error"} (${counts})` }
      : { kind: "dream_finished", detail: `Dream ${outcome === "cut_off" ? "reached its time limit" : "finished"} — ${counts}` },
  );

  if (changes.commits > 0 && deps.refreshHome !== undefined && homeDigest(dataDir, character, home) === homeBefore) {
    try {
      await deps.refreshHome();
    } catch (e) {
      shoreLog.warn(`shore: could not refresh ${character}'s home prompt after a dream: ${String(e)}`);
    }
  }

  return { outcome, startedAt, events, record };
}
