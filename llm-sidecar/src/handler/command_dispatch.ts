/**
 * What the dispatcher does to a command's answer after the command has run.
 *
 * Ported from the four `post_process_*` methods in
 * `crates/daemon/src/handler/command_dispatch.rs`.
 *
 * Four commands reach further than the command layer can. `config` with a value
 * and `config_reset` and `config_reload` all produce a config that subsystems
 * outside the command context are holding older copies of; `switch_character`
 * moves the session itself. The commands do their own half — writing files,
 * validating, computing what changed — and then the dispatcher does the half
 * that needs the handler: pushing the result into the registry and the
 * schedulers, and telling the client what it has to throw away.
 *
 * # Why the annotations are the dispatcher's and not the commands'
 *
 * Everything under `invalidated` is a cache the *client* keeps: the character
 * list, the per-character merged configs, the engines it thinks are live. What
 * a command knows is what it changed on disk; what invalidates a client cache is
 * what the reload turned out to move, which is the reload's return value, and
 * the reload is the handler's. `restart_required` is the same story from the
 * other side — it compares global config to global config, and the command
 * context holds the character-*merged* one, under which every character overlay
 * would read as a change.
 *
 * # One divergence
 *
 * The Rust writes `invalidated` two ways: `config_reset` inserts into whatever
 * the command already put there, `config_reload` replaces the key outright.
 * Here both merge. `configReload` returns no `invalidated` of its own, so there
 * has never been anything for it to replace, and one rule reads better than two.
 */

import type { LoadedConfig } from "../config/loader.ts";
import { restartRequiredChanges } from "../config/restart.ts";
import { historyMessage, type HandshakeProvider } from "../swp/connection.ts";
import type { SessionRouter } from "../swp/session.ts";

/** What adopting a config turned out to move. */
export interface ReloadSummary {
  /** Whether the set of characters on disk changed. */
  readonly characterDiscoveryChanged: boolean;
  /** How many live engines were dropped, their character having gone. */
  readonly droppedEngines: number;
}

/**
 * The handler-owned state these four commands reach into.
 *
 * The same shape `commands/config.ts` uses for its own hooks, and for the same
 * reason: what this module owes the rest of the daemon is a set of calls in an
 * order, and naming them keeps that testable without depending on the registry,
 * the scheduler or the LLM client.
 */
export interface DispatchRuntime {
  /** The global config the daemon is running on — the left side of the
   *  restart-required comparison, and never the character-merged one. */
  globalConfig(): LoadedConfig;

  /** Re-read the file the daemon was started with. `undefined` when it no
   *  longer parses, which drops the annotation rather than failing a command
   *  that already succeeded. */
  reloadGlobalConfig(): LoadedConfig | undefined;

  /** Make `config` this character's effective config, leaving disk alone. */
  setEffectiveConfig(character: string, config: LoadedConfig): Promise<void>;

  /** Hand a runtime config to the schedulers. The Rust calls this on two
   *  autonomy handles that are the same manager. */
  reloadRuntimeConfig(config: LoadedConfig): void;

  /** Adopt `config` across every subsystem that caches part of it, and report
   *  what that invalidated. */
  applyReloadedConfig(config: LoadedConfig): Promise<ReloadSummary>;

  /** Forget the dispatcher's cached active model, which the reset just
   *  cleared from the command context too. */
  clearActiveModel(): void;
}

/** Everything about the request the post-processing needs. */
export interface DispatchContext {
  readonly character: string;
  /**
   * The command context's config *after* the command ran.
   *
   * `config` and the two reloads all mutate it in place, which is exactly what
   * makes it worth pushing outward — it is the new value, already validated.
   */
  readonly config: LoadedConfig;
  readonly sessionId: number;
  readonly rid: string | undefined;
  readonly runtime: DispatchRuntime;
  readonly router: SessionRouter;
  readonly handshake: HandshakeProvider;
}

/**
 * Run a command's after-effects and fold their annotations into its output.
 *
 * Only successful commands get here: the Rust matches on `CommandOutput` and
 * leaves an `Error` alone, and on this side a command that failed threw instead
 * of returning. A command that returns something other than an object keeps its
 * answer unannotated — but its effects still run, because the config a `config`
 * set produced has to reach the registry whatever the reply happened to look
 * like.
 */
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
      // Only a *set*. `config` with no value is a read, and reads must not
      // republish the config — the daemon would adopt the character-merged one
      // as global on every `shore config defaults`.
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

/**
 * A runtime `config` set: publish the merged config, invalidate the client's.
 *
 * This is the one that does not touch disk. The value lives only in the
 * registry's per-character override until something resets it, so the client's
 * merged copy is what goes stale — and only that copy: no character appeared or
 * vanished, so discovery and the engine list are untouched.
 */
async function afterConfigSet(
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown>> {
  await ctx.runtime.setEffectiveConfig(ctx.character, ctx.config);
  ctx.runtime.reloadRuntimeConfig(ctx.config);
  return invalidated(data, { merged_character_configs: true });
}

/**
 * A `config_reset`: drop every runtime override and adopt what is on disk.
 *
 * The command already re-read and validated the file; this adopts it. Because
 * the file may have grown or lost characters since startup, all three caches
 * can move, so all three are reported — `merged_character_configs`
 * unconditionally, since every merged config was rebuilt whether or not any
 * value differs.
 */
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

/**
 * A `config_reload`, in either of its two phases.
 *
 * On apply, the command context already holds the fresh global config. On
 * check it still holds the merged one, so the file is read again — it was just
 * validated, and an edit that breaks it in the meantime only costs the
 * annotation.
 *
 * `restart_required` is computed before the adoption, which is the whole point
 * of doing it here: afterwards the daemon's config *is* the fresh one and every
 * comparison would come back empty.
 */
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

/**
 * A `switch_character`: move the session, and hand it the new conversation.
 *
 * The command decides *whether* the switch is allowed and names the character;
 * only the transport can act on it. Without the pushed history the session
 * would keep rendering the previous character's messages until something else
 * made it reload, which is why this is a push and not a flag.
 *
 * `active_model` is lifted out of the snapshot rather than resolved again, so
 * the model named in the reply is the one the history the client is about to
 * receive was built with.
 */
async function afterSwitchCharacter(
  data: unknown,
  ctx: DispatchContext,
): Promise<Record<string, unknown> | undefined> {
  const selected = isRecord(data) ? data["character"] : undefined;
  if (typeof selected !== "string") return undefined;

  ctx.router.setSelectedCharacter(ctx.sessionId, selected);
  const snapshot = await ctx.handshake.history(selected);
  await ctx.router.sendToSession(ctx.sessionId, historyMessage(snapshot, ctx.rid));

  const config = snapshot.config;
  return {
    selected_character: selected,
    active_model: (isRecord(config) ? config["active_model"] : undefined) ?? null,
  };
}

/** The `invalidated` map, keeping whatever the command already put in it. */
function invalidated(data: unknown, add: Record<string, unknown>): Record<string, unknown> {
  const prev = isRecord(data) && isRecord(data["invalidated"]) ? data["invalidated"] : {};
  return { invalidated: { ...prev, ...add } };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
