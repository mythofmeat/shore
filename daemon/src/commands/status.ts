import type { AutonomyService, AutonomyStatus } from "../autonomy/service.ts";
import { HEARTBEAT_LOG_FILENAME } from "../autonomy/service.ts";
import { HeartbeatLog, type HeartbeatEvent } from "../autonomy/heartbeat_log.ts";
import type { HourClassification } from "../autonomy/activity.ts";
import type { ShoreDirs } from "../config/dirs.ts";
import type { Diagnostics } from "../diagnostics.ts";
import type { ConversationTokens } from "../ledger/conversation_spend.ts";
import { pendingDeferredEditPaths } from "../memory/deferred_edits.ts";
import { invalidRequest } from "./errors.ts";
import { historyIndexSection, type HistoryIndexSource } from "./history_index.ts";
import { workspaceIndexSection, type WorkspaceIndexSource } from "./workspace_index.ts";
import type { Args, Json } from "./conversation.ts";

export interface StatusConfigView {
  app: { defaults: { model: string | undefined } };
  dirs: ShoreDirs;
}

export interface StatusContext {
  characterName: string;
  turnCount: number;
  activeModel: string | undefined;
  config: StatusConfigView;
  conversationTokens: ConversationTokens;
  autonomy: AutonomyService;
  diagnostics: Diagnostics;
  now: () => number;
  localNow: () => number;
  workspaceIndex?: WorkspaceIndexSource | undefined;
  historyIndex?: HistoryIndexSource | undefined;
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

export function autonomyWire(status: AutonomyStatus, now: number): Json {
  const wake = status.next_wake_at;
  const user = status.last_user_at;
  return {
    heartbeat_state: status.heartbeat_state,
    ticks_without_user: status.ticks_without_user,
    dormant_after_heartbeat_turns: status.max_idle_ticks,
    effective_interval_secs: asSecs(status.default_interval_ms),
    ...(wake === undefined
      ? {}
      : { next_wake_at: rfc3339(wake), seconds_until_wake: untilSecs(wake, now) }),
    ...(user === undefined
      ? {}
      : { last_user_at: rfc3339(user), seconds_since_user: sinceSecs(user, now) }),
    minimum_heartbeat_latency_secs: asSecs(status.min_wake_interval_ms),
    dormant_after_idle_time_secs: asSecs(status.max_silent_ms),
    recent_events: status.recent_events,
  };
}

function activityWire(stats: ActivitySource, recorded: number): Json {
  return {
    hour_histogram: stats.hourHistogram,
    hour_classifications: stats.hourClassifications as readonly HourClassification[],
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

export async function status(ctx: StatusContext): Promise<Json> {
  const now = ctx.now();
  const report = ctx.autonomy.activityStats(ctx.characterName, ctx.localNow());
  const state = ctx.autonomy.status(ctx.characterName);

  const effectiveModel = ctx.activeModel ?? ctx.config.app.defaults.model ?? null;

  const characterDataDir = `${ctx.config.dirs.data}/${ctx.characterName}`;
  const pending = await pendingDeferredEditPaths(characterDataDir).catch(() => []);

  const tokens = ctx.conversationTokens;
  const halt = ctx.autonomy.keepaliveHalt();
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
  };
  return {
    character: ctx.characterName,
    keepalive_halted:
      halt === undefined
        ? null
        : { character: halt.character, reason: halt.reason, at: rfc3339(halt.at) },
    message_count: ctx.turnCount,
    turn_count: ctx.turnCount,
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

export function errorLog(ctx: StatusContext, args: Args): Json {
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

export async function heartbeatLog(ctx: StatusContext, args: Args): Promise<Json> {
  const events = await heartbeatEvents(ctx, countArg(args, 20));
  return {
    events: events.map((e) => ({ timestamp: e.timestamp, kind: e.kind, detail: e.detail })),
  };
}

const noState = (character: string): Error =>
  invalidRequest(`No autonomy state for character '${character}'`);

export function heartbeatTickNow(ctx: StatusContext): Json {
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

export function heartbeatSetDormant(ctx: StatusContext): Json {
  if (!ctx.autonomy.forceHeartbeatState(ctx.characterName, "dormant")) {
    throw noState(ctx.characterName);
  }
  return { status: "dormant", character: ctx.characterName };
}

export function heartbeatSetActive(ctx: StatusContext): Json {
  if (!ctx.autonomy.forceHeartbeatState(ctx.characterName, "active")) {
    throw noState(ctx.characterName);
  }
  return { status: "active", character: ctx.characterName };
}
