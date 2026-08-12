import type { LoadedConfig } from "../config/loader.ts";
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

  applyReloadedConfig(config: LoadedConfig): Promise<ReloadSummary>;

  clearActiveModel(): void;
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
    case "config_reset":
      return await afterConfigReset(data, ctx);
    case "config_reload":
      return await afterConfigReload(data, ctx);
    case "switch_character":
      return await afterSwitchCharacter(data, ctx);
    default:
      return undefined;
  }
}

async function afterConfigSet(
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown>> {
  await ctx.runtime.setEffectiveConfig(ctx.character, ctx.config);
  ctx.runtime.reloadRuntimeConfig(ctx.config);
  return invalidated(data, { merged_character_configs: true });
}

async function afterConfigReset(
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown>> {
  ctx.runtime.clearActiveModel();
  const summary = await ctx.runtime.applyReloadedConfig(ctx.config);
  return invalidated(data, {
    character_discovery: summary.characterDiscoveryChanged,
    merged_character_configs: true,
    removed_character_engines: summary.droppedEngines,
  });
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

function invalidated(data: unknown, add: Record<string, unknown>): Record<string, unknown> {
  const prev = isRecord(data) && isRecord(data["invalidated"]) ? data["invalidated"] : {};
  return { invalidated: { ...prev, ...add } };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
