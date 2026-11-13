import { join } from "node:path";

import { shoreLog } from "../../log.ts";
import type { HeartbeatEventKind } from "../../autonomy/heartbeat_log.ts";
import { runBackgroundLoop, type LoopToolResult, type TranscriptRound } from "../../autonomy/background_loop.ts";
import { backgroundModelRequest, backgroundTaskModel } from "../../autonomy/background_model.ts";
import { spanPhrase } from "../../autonomy/wake_shape.ts";
import { foldDiary, unfoldedDiary } from "../../autonomy/diary.ts";
import type { DreamWindow } from "../../autonomy/runner.ts";
import { resolveDisplayName, toolPatternMatches, type ToolsConfig } from "../../config/app.ts";
import { activeJsonlIn, characterDataDir, resolvePromptTemplate, threadDataDir } from "../../config/dirs.ts";
import { findEffectiveModel } from "../../config/effective_catalog.ts";
import type { LoadedConfig } from "../../config/loader.ts";
import { applyBackgroundSettings, configView, resolveChatModelForCharacter } from "../../config/preferences.ts";
import { DIARY_FOR_DREAM, diaryText, formatWallClock } from "../../engine/prompt.ts";
import { homeThreadOf, threadChatModel } from "../../engine/threads.ts";
import type { ContentBlock, Message } from "../../engine/types.ts";
import { buildChatShapeRequestFromDisk } from "../../handler/context.ts";
import { NO_PRIOR_CONTEXT } from "../../engine/segments.ts";
import { usageConfigView } from "../../ledger/budget.ts";
import { budgetBlockFor } from "../../ledger/gate.ts";
import { hostZone } from "../../ledger/zoned.ts";
import { budgetStopIn, describeError } from "../../llm/errors.ts";
import type { GenerateResponse, SidecarRequest, ToolDefinition } from "../../llm/types.ts";
import { truncateSummary } from "../../notifications.ts";
import type { DreamStop } from "../../protocol/DreamStop.ts";
import { durableMark } from "../../storage/files.ts";
import { characterWorkspace } from "../../tools/character_workspace.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import { ALL_TOOLS } from "../../tools/registry.ts";
import { gitCommitFiles, gitCommitsBetween, gitHead, gitPushWorkspace } from "../../tools/workspace.ts";
import { WorkspaceRecorder, workspaceTurnsFor } from "../../tools/workspace_turns.ts";
import { loadCanonicalPromptFile } from "../deferred_edits.ts";
import { conversationLines, conversationsSince } from "./manifest.ts";
import { DEFAULT_DREAM_TEMPLATE, DREAM_OPENER, dreamStoppedNote, dreamWrapUpText, renderDreamPrompt } from "./prompt.ts";
import { forgetWorkspaceReads, mostReadLines, workspaceReadCounts } from "./reads.ts";
import { appendDreamRecord, lastDream, lastFinishedDream, type StoredDream } from "./records.ts";

export const DREAM_TOOL_THREAD = "@dream";

export const DREAM_CALL_TYPE = "dreaming";

export const DREAM_LOOP_CALL_TYPE = "dreaming_tool_loop";

const DREAM_NOTES_FILE = "DREAMS.md";

const LEFT_OUT_TOOLS = new Set(["wake_in_thread", "list_triggers", "write_diary", "send_push", "start_thread", "start_sealed_thread", "edit_thread", "list_threads", "generate_image", "guide"]);

const MOST_READ = 15;

const NOTES_CHARS = 16_000;

const SUMMARY_CHARS = 4_000;

const DREAM_WRAP_UP_ROUNDS = 8;

const MAX_WRAP_UP_MS = 10 * 60_000;

export type DreamPassOutcome = "finished" | "cut_off" | "failed" | "skipped" | "paused" | "interrupted";

export interface DreamEvent {
  kind: HeartbeatEventKind;
  detail: string;
  at: number;
}

export interface DreamPass {
  outcome: DreamPassOutcome;
  events: DreamEvent[];
}

export type WorkspaceWrites = <T>(run: () => Promise<T>) => Promise<T>;

export interface DreamPassDeps {
  generate: (request: SidecarRequest, phase: ToolPhase, signal: AbortSignal) => Promise<GenerateResponse>;
  dispatch: (
    config: LoadedConfig,
    name: string,
    input: unknown,
    toolUseId: string | undefined,
    tools: readonly ToolDefinition[] | undefined,
    writes: WorkspaceWrites,
  ) => Promise<LoopToolResult>;
  recordTranscript?: (round: TranscriptRound) => void;
  refreshHome?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export function dreamToolsConfig(tools: ToolsConfig, chosen: readonly string[] | undefined): ToolsConfig {
  const asked = chosen ?? tools.enabled_tools;
  return {
    ...tools,
    enabled_tools: ALL_TOOLS.map((tool) => tool.name)
      .filter((name) => !LEFT_OUT_TOOLS.has(name) && asked.some((pattern) => toolPatternMatches(pattern, name))),
    enabled_mcp: [],
    enabled_subagents: chosen === undefined
      ? tools.enabled_subagents
      : chosen.flatMap((name) => name.startsWith("ask_") ? [name.slice("ask_".length)] : []),
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

function homeMark(dataDir: string, character: string, home: string): string {
  try {
    return JSON.stringify(durableMark(activeJsonlIn(threadDataDir(dataDir, character, home))) ?? null);
  } catch {
    return "";
  }
}

function cappedNotes(notes: string | undefined): string | undefined {
  const trimmed = notes?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  if (trimmed.length <= NOTES_CHARS) return trimmed;
  const last = trimmed.charCodeAt(NOTES_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? NOTES_CHARS - 1 : NOTES_CHARS;
  return `${trimmed.slice(0, end).trimEnd()}\n\n[Cut here: read ${DREAM_NOTES_FILE} for the rest.]`;
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

function dreamWrites(config: LoadedConfig, character: string): { track: WorkspaceWrites; commits: () => string[]; done: () => Promise<void> } {
  const workspace = characterWorkspace(config, character);
  const recorder = new WorkspaceRecorder(workspaceTurnsFor(config.dirs, character, workspace));
  const commits = new Set<string>();
  const track = async <T>(run: () => Promise<T>): Promise<T> => await recorder.track(async () => {
    const before = await gitHead(workspace).catch(() => undefined);
    try {
      return await run();
    } finally {
      const after = await gitHead(workspace).catch(() => undefined);
      if (after !== undefined && after !== before) {
        for (const sha of await gitCommitsBetween(workspace, before, after).catch(() => [])) commits.add(sha);
      }
    }
  });
  return { track, commits: () => [...commits], done: async () => { await recorder.discard(); } };
}

function stopOf(loop: Awaited<ReturnType<typeof runBackgroundLoop>>, interrupted: boolean): { outcome: "finished" | "cut_off" | "failed" | "interrupted"; stoppedBy?: DreamStop } {
  if (interrupted) return { outcome: "interrupted", stoppedBy: "shutdown" };
  if (budgetStopIn(loop.failure) !== undefined) return { outcome: "interrupted", stoppedBy: "budget" };
  if (loop.timedOut === true || loop.stoppedAt === "time") return { outcome: "cut_off", stoppedBy: "time_limit" };
  if (loop.stoppedAt === "rounds") return { outcome: "cut_off", stoppedBy: "round_limit" };
  return { outcome: loop.failedRound === undefined ? "finished" : "failed" };
}

function endDetail(outcome: string, stoppedBy: DreamStop | undefined, error: string | undefined, counts: string): string {
  if (outcome === "failed") return `Dream failed — ${error ?? "unknown error"} (${counts})`;
  if (stoppedBy === "budget") return `Dream paused by a usage budget — ${error ?? "budget reached"} (${counts})`;
  if (stoppedBy === "shutdown") return `Dream stopped when Shore shut down — ${counts}`;
  if (stoppedBy === "round_limit") return `Dream used up its rounds — ${counts}`;
  if (stoppedBy === "time_limit") return `Dream reached its time limit — ${counts}`;
  return `Dream finished — ${counts}`;
}

export async function defaultPush(config: LoadedConfig, character: string): Promise<boolean> {
  return await gitPushWorkspace(characterWorkspace(config, character));
}

export async function runDreamPass(
  character: string,
  config: LoadedConfig,
  start: DreamWindow,
  deps: DreamPassDeps,
): Promise<DreamPass> {
  const startedAt = Date.now();
  const events: DreamEvent[] = [];
  const event = (kind: HeartbeatEventKind, detail: string): void => {
    events.push({ kind, detail, at: Date.now() });
  };
  const failed = (detail: string): DreamPass => {
    event("dream_failed", detail);
    return { outcome: "failed", events };
  };
  const dataDir = config.dirs.data;
  const characterDir = characterDataDir(dataDir, character);
  const timeZone = hostZone();
  const userName = resolveDisplayName(config.app.defaults, deps.env);
  const workspace = characterWorkspace(config, character);
  const dreaming = config.app.memory.dreaming;

  const finishedBefore = lastFinishedDream(characterDir);
  const anchoredAt = finishedBefore === undefined ? Number.NaN : Date.parse(finishedBefore.started_at);
  const sinceMs = Number.isNaN(anchoredAt) ? start.since : anchoredAt;
  const home = await homeThreadOf(dataDir, character);
  const conversations = await conversationsSince(dataDir, character, sinceMs);
  if (conversations.length === 0 && !start.forced) {
    shoreLog.info(`shore: dream for ${character} skipped, nothing has been archived since ${new Date(sinceMs).toISOString()}`);
    return { outcome: "skipped", events };
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

  const { limitMs, wrapUpMs } = dreamLimits(config);
  const timeLimit = spanPhrase(limitMs);
  const seenReads = workspaceReadCounts(characterDir);
  const reads = mostReadLines(seenReads, MOST_READ);
  const template = resolvePromptTemplate(config.dirs.config, character, "dream.md") ?? DEFAULT_DREAM_TEMPLATE;
  const rendered = renderDreamPrompt(template, {
    now: formatWallClock(startedAt, timeZone),
    userName,
    characterName: character,
    lastDream: Number.isNaN(anchoredAt) ? undefined : formatWallClock(anchoredAt, timeZone),
    conversations: conversationLines(
      conversations,
      finishedBefore?.head === undefined ? `--since=${new Date(sinceMs).toISOString()}` : `${finishedBefore.head.slice(0, 7)}..HEAD`,
    ),
    reads: reads.length === 0 ? undefined : reads.join("\n"),
    notes: cappedNotes(await loadCanonicalPromptFile(workspace, DREAM_NOTES_FILE).catch(() => undefined)),
    timeLimit,
    wrapUpAfter: spanPhrase(limitMs - wrapUpMs),
  });
  const latest = lastDream(characterDir);
  const stoppedNote = latest === undefined || latest.outcome === "finished"
    ? undefined
    : dreamStoppedNote({ startedAt: Date.parse(latest.started_at), outcome: latest.outcome, stoppedBy: latest.stopped_by }, timeLimit, timeZone);
  const timestamp = new Date(startedAt).toISOString();
  const diary = unfoldedDiary(characterDir);
  const diaryNote = diary.length === 0 ? undefined : diaryText(diary, DIARY_FOR_DREAM, timeZone);
  const messages = [
    note(DREAM_OPENER, timestamp, "user"),
    note([stoppedNote, rendered, diaryNote].filter((part) => part !== undefined).join("\n\n"), timestamp, "system"),
  ];

  const scoped = dreamConfig(config);
  const dropped = (dreaming.tools ?? []).filter((name) => LEFT_OUT_TOOLS.has(name) || name.startsWith("mcp__"));
  if (dropped.length > 0) {
    shoreLog.warn(`shore: dream for ${character} leaves out ${dropped.join(", ")} from dreaming.tools; dreams never get scheduling, thread, picture or MCP tools`);
  }
  let built: Awaited<ReturnType<typeof buildChatShapeRequestFromDisk>>;
  try {
    built = await buildChatShapeRequestFromDisk(character, characterDir, scoped, resolved, messages, NO_PRIOR_CONTEXT, {
      mcpToolDefs: [],
      canonicalPromptFiles: true,
      activeConversation: true,
      timeZone,
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });
  } catch (e) {
    shoreLog.warn(`shore: dream for ${character} could not build its request: ${String(e)}`);
    return failed(`Dream could not build its request — ${truncateSummary(String(e), 200)}`);
  }
  const { request, override } = backgroundModelRequest(built.request, scoped, character, deps.env, configured, "dream");
  request.context = {
    ...request.context,
    ledger: join(dataDir, "shore.db"),
    usage: usageConfigView(config.app.usage),
    character,
    call_type: DREAM_CALL_TYPE,
    thinking_enabled: request.context?.thinking_enabled ?? false,
  };

  const blocked = budgetBlockFor(request);
  if (blocked !== undefined) {
    event("budget_paused", `Dream paused before it started — ${blocked.summary}`);
    return { outcome: "paused", events };
  }

  event("dream_started", `Dream started over ${counted(conversations.length, "conversation")}`);
  const homeBefore = homeMark(dataDir, character, home);
  const headBefore = await gitHead(workspace).catch(() => undefined);
  const writes = dreamWrites(config, character);
  let summary = "";
  const loop = await runBackgroundLoop(request, {
    character,
    name: "Dream",
    generate: async (call, phase, signal) => await deps.generate(call, phase, AbortSignal.any([start.signal, signal])),
    dispatch: async (name, input, toolUseId, tools) => {
      start.signal.throwIfAborted();
      return await deps.dispatch(scoped, name, input, toolUseId, tools, writes.track);
    },
    note: (detail) => {
      if (!detail.startsWith("Tool: ")) event("tool_use", detail);
    },
    ...(deps.recordTranscript === undefined ? {} : { recordTranscript: deps.recordTranscript }),
    persist: async (round) => {
      if (round.role !== "assistant") return;
      summary = round.blocks.some((block) => block.type === "tool_use") ? "" : textOf(round.blocks);
    },
    wrapUpGrace: DREAM_WRAP_UP_ROUNDS,
    maxToolIterations: (override ?? resolved).maxToolIterations,
    timeLimitMs: limitMs,
    wrapUpMs,
    wrapUpText: dreamWrapUpText,
    callTypes: [DREAM_CALL_TYPE, DREAM_LOOP_CALL_TYPE],
  });
  await writes.done();

  const interrupted = start.signal.aborted;
  const { outcome, stoppedBy } = stopOf(loop, interrupted);
  const commits = writes.commits();
  const files = await gitCommitFiles(workspace, commits).catch(() => []);
  const headAfter = await gitHead(workspace).catch(() => headBefore);
  let pushed: boolean | undefined;
  if (config.app.memory.git_push && commits.length > 0 && !interrupted) {
    try {
      pushed = await defaultPush(config, character);
    } catch (e) {
      shoreLog.warn(`shore: could not push ${character}'s workspace after a dream: ${String(e)}`);
      pushed = false;
    }
  }

  const budget = budgetStopIn(loop.failure);
  const error = outcome === "failed"
    ? truncateSummary(describeError(loop.failure), 300)
    : stoppedBy === "budget" ? truncateSummary(budget?.summary ?? budget?.message ?? "a usage budget was reached", 300) : undefined;
  const record: StoredDream = {
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date().toISOString(),
    outcome,
    conversations: conversations.length,
    commits: commits.length,
    files,
    ...(pushed === undefined ? {} : { pushed }),
    ...(summary === "" ? {} : { summary: truncateSummary(summary, SUMMARY_CHARS) }),
    ...(error === undefined ? {} : { error }),
    ...(stoppedBy === undefined ? {} : { stopped_by: stoppedBy }),
    ...(headAfter === undefined ? {} : { head: headAfter }),
  };
  appendDreamRecord(characterDir, record);
  if (outcome === "finished") forgetWorkspaceReads(characterDir, seenReads);
  if (outcome === "finished") foldDiary(characterDir, diary.map((entry) => entry.id));

  const counts = `${counted(commits.length, "commit")}, ${counted(files.length, "file")}` +
    (pushed === undefined ? "" : pushed ? ", pushed" : ", not pushed");
  event(
    outcome === "failed" ? "dream_failed" : stoppedBy === "budget" ? "budget_paused" : "dream_finished",
    endDetail(outcome, stoppedBy, error, counts),
  );

  if (!interrupted && commits.length > 0 && deps.refreshHome !== undefined && homeMark(dataDir, character, home) === homeBefore) {
    try {
      await deps.refreshHome();
    } catch (e) {
      shoreLog.warn(`shore: could not refresh ${character}'s home prompt after a dream: ${String(e)}`);
    }
  }

  return { outcome: stoppedBy === "budget" ? "paused" : outcome, events };
}
