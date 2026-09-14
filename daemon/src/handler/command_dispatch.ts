import type { LoadedConfig } from "../config/loader.ts";
import type { InvalidationReason } from "../cache/last_request.ts";
import { restartRequiredChanges } from "../config/restart.ts";
import { historyMessage, type HandshakeProvider, type HistorySnapshot } from "../swp/connection.ts";
import type { SessionRouter } from "../swp/session.ts";

export interface ReloadSummary {
  readonly characterDiscoveryChanged: boolean;
  readonly droppedEngines: number;
}

export interface DispatchRuntime {
  globalConfig(): LoadedConfig;

  reloadGlobalConfig(): LoadedConfig | undefined;

  setEffectiveConfig(character: string, config: LoadedConfig): Promise<void>;

  reloadRuntimeConfig(config: LoadedConfig): void;

  refreshCachedRequest(
    character: string,
    reason?: InvalidationReason,
    thread?: string,
  ): Promise<void>;

  homeThread(character: string): string;

  applyReloadedConfig(config: LoadedConfig): Promise<ReloadSummary>;
}

export interface DispatchContext {
  readonly character: string;
  readonly config: LoadedConfig;
  readonly sessionId: number;
  readonly rid: string | undefined;
  readonly runtime: DispatchRuntime;
  readonly router: SessionRouter;
  readonly handshake: HandshakeProvider;
}

export async function afterCommand(
  name: string,
  args: unknown,
  data: unknown,
  ctx: DispatchContext,
): Promise<unknown> {
  const extra = await annotations(name, args, data, ctx);
  if (extra === undefined || !isRecord(data)) return data;
  return { ...data, ...extra };
}

async function annotations(
  name: string,
  args: unknown,
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown> | undefined> {
  switch (name) {
    case "config":
      return isRecord(args) && typeof args["value"] === "string"
        ? await afterConfigSet(data, ctx)
        : undefined;
    case "config_reload":
      return await afterConfigReload(data, ctx);
    case "switch_model":
    case "reset_model":
    case "set_model_setting":
      return await afterChatModelChange(name, args, data, ctx);
    case "switch_character":
      return await afterSwitchCharacter(data, ctx);
    case "switch_thread":
      return await afterSwitchThread(args, data, ctx);
    case "thread_model":
      return await afterThreadModelChange(args, data, ctx);
    default:
      return undefined;
  }
}

async function afterChatModelChange(
  name: string,
  args: unknown,
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown> | undefined> {
  if (!isRecord(args)) return undefined;
  if (name === "switch_model" && typeof args["name"] !== "string") return undefined;
  if (
    name !== "set_model_setting" &&
    (args["background_task"] !== undefined || args["subagent"] !== undefined)
  ) return undefined;

  await ctx.runtime.refreshCachedRequest(
    ctx.character, name === "set_model_setting" ? "model_setting_change" : "model_change",
    ctx.router.threadFor(ctx.sessionId) ?? ctx.runtime.homeThread(ctx.character),
  );
  return invalidated(data, { cached_request: true });
}

async function afterConfigSet(
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown>> {
  await ctx.runtime.setEffectiveConfig(ctx.character, ctx.config);
  ctx.runtime.reloadRuntimeConfig(ctx.config);
  return invalidated(data, { merged_character_configs: true });
}

async function afterConfigReload(
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown> | undefined> {
  const applied = isRecord(data) && data["applied"] === true;
  const fresh = applied ? ctx.config : ctx.runtime.reloadGlobalConfig();
  if (fresh === undefined) return undefined;

  const restart = { restart_required: restartRequiredChanges(ctx.runtime.globalConfig(), fresh) };
  if (!applied) return restart;

  const summary = await ctx.runtime.applyReloadedConfig(fresh);
  return {
    ...restart,
    ...invalidated(data, {
      character_discovery: summary.characterDiscoveryChanged,
      merged_character_configs: true,
      removed_character_engines: summary.droppedEngines,
    }),
  };
}

async function afterSwitchCharacter(
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown> | undefined> {
  const selected = isRecord(data) ? data["character"] : undefined;
  if (typeof selected !== "string") return undefined;

  const previous = ctx.router.characterFor(ctx.sessionId);
  ctx.router.setSelectedCharacter(ctx.sessionId, selected);

  let snapshot: HistorySnapshot;
  try {
    snapshot = await ctx.handshake.history(selected);
  } catch (e) {
    ctx.router.setSelectedCharacter(ctx.sessionId, previous);
    throw e;
  }

  await ctx.router.sendToSession(ctx.sessionId, historyMessage(snapshot, ctx.rid));

  const config = snapshot.config;
  return {
    selected_character: selected,
    active_model: (isRecord(config) ? config["active_model"] : undefined) ?? null,
  };
}

async function afterSwitchThread(
  args: unknown,
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown> | undefined> {
  const selected = isRecord(data) ? data["thread"] : undefined;
  if (typeof selected !== "string") return undefined;
  const changed = isRecord(data) && data["changed"] === true;
  const resync = isRecord(args) && args["resync"] === true;
  if (!changed && !resync) return undefined;

  const previous = ctx.router.threadFor(ctx.sessionId);
  ctx.router.setSelectedThread(ctx.sessionId, selected);

  let snapshot: HistorySnapshot;
  try {
    snapshot = await ctx.handshake.history(ctx.character, selected);
  } catch (e) {
    ctx.router.setSelectedThread(ctx.sessionId, previous);
    throw e;
  }

  await ctx.router.sendToSession(ctx.sessionId, historyMessage(snapshot, ctx.rid));
  if (!changed) return undefined;
  await ctx.runtime.refreshCachedRequest(ctx.character, "thread_change", selected);

  return {
    selected_thread: selected,
    ...invalidated(data, { cached_request: true }),
  };
}

async function afterThreadModelChange(
  args: unknown,
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown> | undefined> {
  const pinned = isRecord(args) ? args["name"] : undefined;
  if (typeof pinned !== "string") return undefined;

  const live =
    ctx.router.threadFor(ctx.sessionId) ?? ctx.runtime.homeThread(ctx.character);
  if (pinned !== live) return undefined;

  await ctx.runtime.refreshCachedRequest(ctx.character, "model_change", pinned);
  return invalidated(data, { cached_request: true });
}

function invalidated(data: unknown, add: Record<string, unknown>): Record<string, unknown> {
  const prev = isRecord(data) && isRecord(data["invalidated"]) ? data["invalidated"] : {};
  return { invalidated: { ...prev, ...add } };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
