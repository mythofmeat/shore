import type { AutonomyService, AutonomyStatus } from "../autonomy/service.ts";
import { HEARTBEAT_LOG_FILENAME } from "../autonomy/service.ts";
import { HeartbeatLog, type HeartbeatEvent } from "../autonomy/heartbeat_log.ts";
import type { HourClassification } from "../autonomy/activity.ts";
import type { ShoreDirs } from "../config/dirs.ts";
import type { Diagnostics } from "../diagnostics.ts";
import type { ConversationTokens } from "../ledger/conversation_spend.ts";
import type { McpServerStatus } from "../tools/mcp_registry.ts";
import { pendingDeferredEditPaths } from "../memory/deferred_edits.ts";
import { invalidRequest } from "./errors.ts";
import { historyIndexSection, type HistoryIndexSource } from "./history_index.ts";
import { workspaceIndexSection, type WorkspaceIndexSource } from "./workspace_index.ts";
import type { OperationInput, OperationResult } from "../operations/types.ts";
import type { AutonomyStatusReport } from "../protocol/AutonomyStatusReport.ts";
import type { McpStatusReport } from "../protocol/McpStatusReport.ts";
import type { ActivityStatusReport } from "../protocol/ActivityStatusReport.ts";

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
  workspaceIndex?: WorkspaceIndexSource | undefined;
  historyIndex?: HistoryIndexSource | undefined;
  mcpServers?: readonly McpServerStatus[] | undefined;
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
  const wake = autonomy.next_wake_at;
  const user = autonomy.last_user_at;
  return {
    heartbeat_state: autonomy.heartbeat_state,
    ticks_without_user: autonomy.ticks_without_user,
    dormant_after_heartbeat_turns: autonomy.max_idle_ticks,
    default_interval_secs: asSecs(autonomy.default_interval_ms),
    ...(wake === undefined
      ? {}
      : { next_wake_at: rfc3339(wake), seconds_until_wake: untilSecs(wake, now) }),
    ...(user === undefined
      ? {}
      : { last_user_at: rfc3339(user), seconds_since_user: sinceSecs(user, now) }),
    min_interval_secs: asSecs(autonomy.min_interval_ms),
    max_interval_secs: asSecs(autonomy.max_interval_ms),
    dormant_after_idle_time_secs: asSecs(autonomy.max_silent_ms),
    recent_events: autonomy.recent_events,
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
    turn_count: recorded,
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
  const sections = {
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cache_read: tokens.cache_read,
      cache_write: tokens.cache_write,
    },
    autonomy: state === undefined ? null : autonomyWire(state, now),
    activity: report === undefined ? null : activityWire(report.stats, report.messageCount),
    index: await workspaceIndexSection(ctx.workspaceIndex, ctx.characterName),
    history_index: await historyIndexSection(ctx.historyIndex, ctx.characterName),
    ...(mcp === undefined ? {} : { mcp }),
  };
  return {
    character: ctx.characterName,
    keepalive_halts: halts.map((halt) => ({
      character: halt.character,
      model: halt.model,
      reason: halt.reason,
      at: rfc3339(halt.at),
    })),
    message_count: ctx.turnCount,
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

async function heartbeatEvents(
  ctx: StatusContext,
  limit: number,
): Promise<readonly HeartbeatEvent[]> {
  if (ctx.autonomy.runnerFor(ctx.characterName) !== undefined) {
    return ctx.autonomy.log(ctx.characterName, limit);
  }
  const path = `${ctx.config.dirs.data}/${ctx.characterName}/${HEARTBEAT_LOG_FILENAME}`;
  return (await HeartbeatLog.load(path)).recent(limit);
}

export async function heartbeatLog(ctx: StatusContext, args: OperationInput<"heartbeat_log">): Promise<OperationResult<"heartbeat_log">> {
  const events = await heartbeatEvents(ctx, countArg(args, 20));
  return {
    events: events.map((e) => ({ timestamp: e.timestamp, kind: e.kind, detail: e.detail })),
  };
}

const noState = (character: string): Error =>
  invalidRequest(`No autonomy state for character '${character}'`);

export function heartbeatTickNow(ctx: StatusContext): OperationResult<"heartbeat_tick_now"> {
  const dormant = ctx.autonomy.forceHeartbeatNow(ctx.characterName);
  if (dormant === undefined) throw noState(ctx.characterName);
  return {
    status: "scheduled",
    character: ctx.characterName,
    ...(dormant
      ? {
          warning:
            "Heartbeat is dormant. The scheduled tick will be suppressed " +
            "by the abandonment guard. Run `shore debug heartbeat_status_active` " +
            "first to wake the clock.",
        }
      : {}),
  };
}

export function heartbeatSetDormant(ctx: StatusContext): OperationResult<"heartbeat_set_dormant"> {
  if (!ctx.autonomy.forceHeartbeatState(ctx.characterName, "dormant")) {
    throw noState(ctx.characterName);
  }
  return { status: "dormant", character: ctx.characterName };
}

export function heartbeatSetActive(ctx: StatusContext): OperationResult<"heartbeat_set_active"> {
  if (!ctx.autonomy.forceHeartbeatState(ctx.characterName, "active")) {
    throw noState(ctx.characterName);
  }
  return { status: "active", character: ctx.characterName };
}
