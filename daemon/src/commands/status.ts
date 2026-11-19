import type { AutonomyService, AutonomyStatus } from "../autonomy/service.ts";
import { WAKE_LOG_FILENAME } from "../autonomy/service.ts";
import { WakeLog, type WakeEvent } from "../autonomy/wake_log.ts";
import type { HourClassification } from "../autonomy/activity.ts";
import type { ShoreDirs } from "../config/dirs.ts";
import type { Diagnostics } from "../diagnostics.ts";
import type { ConversationTokens } from "../ledger/conversation_spend.ts";
import type { McpServerStatus } from "../tools/mcp_registry.ts";
import { pendingDeferredEditPaths } from "../memory/deferred_edits.ts";
import { invalidRequest } from "./errors.ts";
import { historyIndexSection, type HistoryIndexSource } from "./history_index.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
import type { AutonomyStatusReport } from "../protocol/AutonomyStatusReport.ts";
import type { McpStatusReport } from "../protocol/McpStatusReport.ts";
import type { ActivityStatusReport } from "../protocol/ActivityStatusReport.ts";
import type { RunningStatusReport } from "../protocol/RunningStatusReport.ts";
import type { TriggersStatusReport } from "../protocol/TriggersStatusReport.ts";
import type { TriggersView } from "../autonomy/trigger_loop.ts";
import { hostZone } from "../ledger/zoned.ts";
import { describeTrigger, userVoice } from "../tools/list_triggers.ts";

type Args = OperationInput<"error_log">;

interface StatusConfigView {
  app: { defaults: { model: string | undefined } };
  dirs: ShoreDirs;
}

export interface StatusContext {
  thread?: string;
  characterName: string;
  turnCount: number;
  activeModel: string | undefined;
  config: StatusConfigView;
  conversationTokens: ConversationTokens;
  contextTokens?: number | undefined;
  autonomy: AutonomyService;
  diagnostics: Diagnostics;
  now: () => number;
  localNow: () => number;
  historyIndex?: HistoryIndexSource | undefined;
  mcpServers?: readonly McpServerStatus[] | undefined;
  running?: RunningStatusReport | undefined;
}

function countArg(args: Args, fallback: number): number {
  const v = args["count"];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
}

const asSecs = (ms: number): number => Math.floor(ms / 1000);

export function rfc3339(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.replace(/\.000Z$/, "").replace(/Z$/, "")}+00:00`;
}

export const untilSecs = (at: number, now: number): number => Math.trunc((at - now) / 1000);

const sinceSecs = (at: number, now: number): number => Math.max(0, Math.trunc((now - at) / 1000));

export function autonomyWire(autonomy: AutonomyStatus, now: number): AutonomyStatusReport {
  const user = autonomy.last_user_at;
  return {
    state: autonomy.state,
    wakes_without_user: autonomy.wakes_without_user,
    dormant_after_wakes: autonomy.max_idle_wakes,
    ...(user === undefined
      ? {}
      : { last_user_at: rfc3339(user), seconds_since_user: sinceSecs(user, now) }),
    dormant_after_idle_time_secs: asSecs(autonomy.max_silent_ms),
    recent_events: autonomy.recent_events,
  };
}

export function triggersWire(view: TriggersView, character: string, active: boolean, timeZone: string): TriggersStatusReport {
  const due = view.enabled && active
    ? view.triggers.flatMap((each) => (each.trigger.wakes && !each.off && each.nextAt !== undefined ? [{ trigger: each.trigger.name, at: each.nextAt }] : []))
    : [];
  const next = due.reduce<(typeof due)[number] | undefined>((soonest, each) => (soonest !== undefined && soonest.at <= each.at ? soonest : each), undefined);
  return {
    enabled: view.enabled,
    ...(next === undefined ? {} : { next_wake: { trigger: next.trigger, at: rfc3339(next.at) } }),
    triggers: view.triggers.map((each) => describeTrigger(each, userVoice(character), timeZone)),
    not_running: view.problems,
  };
}

function mcpWire(servers: readonly McpServerStatus[]): McpStatusReport {
  return {
    configured: servers.length,
    connected: servers.filter((server) => server.state === "connected").length,
    unavailable: servers.filter((server) => server.state !== "connected").length,
    servers: servers.map((server) => ({
      name: server.name,
      transport: server.transport,
      state: server.state,
      connected_tools: server.connected_tools,
      last_error: server.last_error,
      next_retry_at:
        server.next_retry_at === null ? null : rfc3339(server.next_retry_at),
    })),
  };
}

function activityWire(stats: ActivitySource, recorded: number): ActivityStatusReport {
  return {
    hour_histogram: [...stats.hourHistogram],
    hour_classifications: [...stats.hourClassifications],
    has_sufficient_heatmap: stats.hasSufficientHeatmap,
    engagement_score: stats.engagementScore,
    sessions_per_day: stats.sessionsPerDay,
    message_count: recorded,
  };
}

interface ActivitySource {
  hourHistogram: readonly number[];
  hourClassifications: readonly HourClassification[];
  hasSufficientHeatmap: boolean;
  engagementScore: number;
  sessionsPerDay: number;
}

export async function status(ctx: StatusContext): Promise<OperationResult<"status">> {
  const now = ctx.now();
  const report = ctx.autonomy.activityStats(ctx.characterName, ctx.localNow());
  const state = ctx.autonomy.status(ctx.characterName);

  const effectiveModel = ctx.activeModel ?? ctx.config.app.defaults.model ?? null;

  const characterDataDir = `${ctx.config.dirs.data}/${ctx.characterName}`;
  const pending = await pendingDeferredEditPaths(characterDataDir, ctx.thread).catch(() => []);

  const tokens = ctx.conversationTokens;
  const halts = ctx.autonomy.keepaliveHalts(ctx.characterName);
  const mcp = ctx.mcpServers === undefined ? undefined : mcpWire(ctx.mcpServers);
  const view = await ctx.autonomy.triggers(ctx.characterName);
  const triggers = view === undefined ? undefined : triggersWire(view, ctx.characterName, state?.state === "Active", hostZone());
  const sections = {
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cache_read: tokens.cache_read,
      cache_write: tokens.cache_write,
    },
    autonomy: state === undefined ? null : autonomyWire(state, now),
    ...(triggers === undefined ? {} : { triggers }),
    activity: report === undefined ? null : activityWire(report.stats, report.messageCount),
    history_index: historyIndexSection(ctx.historyIndex, ctx.characterName),
    ...(mcp === undefined ? {} : { mcp }),
    ...(ctx.running === undefined ? {} : { running: ctx.running }),
  };
  return {
    character: ctx.characterName,
    keepalive_halts: halts.map((halt) => ({
      character: halt.character,
      model: halt.model,
      reason: halt.reason,
      at: rfc3339(halt.at),
    })),
    turn_count: ctx.turnCount,
    ...(ctx.contextTokens === undefined ? {} : { context_tokens: ctx.contextTokens }),
    active_model: effectiveModel,
    config_dir: ctx.config.dirs.config,
    data_dir: ctx.config.dirs.data,
    cache_dir: ctx.config.dirs.cache,
    pending_deferred_edit_count: pending.length,
    pending_deferred_edits: pending,
    ...sections,
    sections: Object.keys(sections),
  };
}

export function errorLog(ctx: StatusContext, args: OperationInput<"error_log">): OperationResult<"error_log"> {
  return ctx.diagnostics.toJson(countArg(args, 20));
}

async function wakeEvents(
  ctx: StatusContext,
  limit: number,
): Promise<readonly WakeEvent[]> {
  if (ctx.autonomy.runnerFor(ctx.characterName) !== undefined) {
    return ctx.autonomy.log(ctx.characterName, limit);
  }
  const path = `${ctx.config.dirs.data}/${ctx.characterName}/${WAKE_LOG_FILENAME}`;
  return (await WakeLog.load(path)).recent(limit);
}

export async function wakeLog(ctx: StatusContext, args: OperationInput<"wake_log">): Promise<OperationResult<"wake_log">> {
  const events = await wakeEvents(ctx, countArg(args, 20));
  return {
    events: events.map((e) => ({ timestamp: e.timestamp, kind: e.kind, detail: e.detail })),
  };
}

const noState = (character: string): Error =>
  invalidRequest(`No autonomy state for character '${character}'`);

export function wakeNow(ctx: StatusContext): OperationResult<"wake_now"> {
  const dormant = ctx.autonomy.wakeNow(ctx.characterName);
  if (dormant === undefined) throw noState(ctx.characterName);
  return {
    status: "queued",
    character: ctx.characterName,
    ...(dormant
      ? {
          warning:
            `${ctx.characterName} is dormant, so nothing wakes them and this wake is dropped. ` +
            "Run `shore debug set_active` first.",
        }
      : {}),
  };
}

export function setDormant(ctx: StatusContext): OperationResult<"set_dormant"> {
  if (!ctx.autonomy.forceDormancy(ctx.characterName, "dormant")) {
    throw noState(ctx.characterName);
  }
  return { status: "dormant", character: ctx.characterName };
}

export function setActive(ctx: StatusContext): OperationResult<"set_active"> {
  if (!ctx.autonomy.forceDormancy(ctx.characterName, "active")) {
    throw noState(ctx.characterName);
  }
  return { status: "active", character: ctx.characterName };
}
