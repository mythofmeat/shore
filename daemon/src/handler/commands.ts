/**
 * The command path: the `dispatchCommand` `handler/router.ts` injects.
 *
 * Ported from `MessageHandler::dispatch_command` and the three helpers under it
 * in `crates/daemon/src/handler/command_dispatch.rs`, pinned by
 * `tests/handler_fixtures/command_path_parity.json`.
 *
 * The table itself is `commands/dispatch.ts` and the four post-processing hooks
 * are `handler/command_dispatch.ts`. What is left, and what this is, is
 * everything between a `Command` frame arriving and the table running:
 *
 * 1. **Which of three paths the name takes.** Two never touch a character
 *    engine, and one of those is chosen *per request* rather than per name —
 *    `list_models` is characterless only while no character is selected, so
 *    that `shore complete models` works before anyone has chosen one, and so
 *    that once they have, its `active` field is the one preferences resolve.
 * 2. **Resolving the session's character** to an engine and an effective
 *    config, or failing with a message that says which of the three ways it
 *    went wrong: none on disk, several and none chosen, or one chosen that is
 *    not there.
 * 3. **Building the command context**, whose active model comes from
 *    preferences and not from the app default — with the legacy
 *    `runtime_state.json` still read underneath, as one release of migration.
 * 4. **Mirroring the active model back into the session**, because it is a
 *    cache the next command reads instead of re-resolving.
 *
 * # One deliberate divergence
 *
 * **Every path attaches the rid.** The Rust attached it on the character path
 * and on the `refresh_provider_models` bypass, and forgot it on the third:
 * `list_characters`, characterless `list_models` and `list_providers` all came
 * back with a null rid however the request was addressed. Three paths, two
 * spellings, and a client correlating by rid loses exactly those three answers.
 * The fixture records the Rust's null and the replay names this rather than
 * letting it pass.
 */

import type { Command } from "../protocol/Command.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { configView, resolveActiveModelAndOverlay } from "../config/preferences.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import { CharacterError } from "../characters.ts";
import {
  commandFrame,
  isCharacterless,
  runCharacterlessCommand,
  runCommand,
  type CommandDeps,
  type CommandSession,
} from "../commands/dispatch.ts";
import { internalError, invalidRequest } from "../commands/errors.ts";
import type { ConfigRuntime } from "../commands/config.ts";
import type { Args } from "../commands/navigation.ts";
import { afterCommand, type DispatchRuntime, type ReloadSummary } from "./command_dispatch.ts";
import type { HandshakeProvider } from "../swp/connection.ts";
import type { SessionRouter } from "../swp/session.ts";
import type { RequestMeta } from "../swp/session.ts";

/** The character registry, as this path reads it. */
export interface CommandRegistry {
  /** The character a request is for. Throws {@link CharacterError} when the
   *  session's selection cannot be turned into exactly one name. */
  resolveCharacter(selected: string | undefined): string;
  getOrCreate(name: string): Promise<ConversationEngine>;
  effectiveConfig(name: string): LoadedConfig;
}

/** The per-session active-model cache, which is all this path keeps. */
export interface SessionCache {
  activeModel(sessionId: number): string | undefined;
  setActiveModel(sessionId: number, model: string | undefined): void;
}

export interface CommandPathDeps {
  registry: CommandRegistry;
  /** The config the daemon was started with, for the characterless paths. */
  globalConfig(): LoadedConfig;
  /** The file it was started *from* — never a character's overlay. */
  configPath: string;
  dataDir: string;
  sessions: SessionCache;
  /** What the table needs beyond the session. */
  commands: CommandDeps;
  /** The schedulers and the ledger, for the commands that reconfigure them. */
  runtime: ConfigRuntime;
  /** The handler-owned state the four post-processing hooks reach into. */
  dispatchRuntime: DispatchRuntime;
  router: SessionRouter;
  handshake: HandshakeProvider;
  env?: NodeJS.ProcessEnv;
}

/** Bind the handler's state into the callback the router calls per command. */
export function makeDispatchCommand(
  deps: CommandPathDeps,
): (cmd: Command, meta: RequestMeta) => Promise<ServerMessage> {
  return (cmd, meta) => dispatchCommand(deps, cmd, meta);
}

/** Route one command, run it, and annotate what it produced. */
export async function dispatchCommand(
  deps: CommandPathDeps,
  cmd: Command,
  meta: RequestMeta,
): Promise<ServerMessage> {
  const sessionId = meta.session.sessionId;
  const selected = meta.session.selectedCharacter ?? undefined;
  const rid = meta.rid ?? undefined;

  // `refresh_provider_models` is character-agnostic like the three below, and
  // async, which is the only reason the Rust gave it a bypass of its own. Here
  // every path is async and the distinction has nothing left in it — so it
  // joins them, and the fixture's separate case for it still passes.
  if (isCharacterless(cmd.name) && !(cmd.name === "list_models" && selected !== undefined)) {
    return characterlessCommand(deps, cmd, sessionId, rid);
  }
  if (cmd.name === "refresh_provider_models") {
    return characterlessCommand(deps, cmd, sessionId, rid);
  }

  let character: string;
  try {
    character = deps.registry.resolveCharacter(selected);
  } catch (e) {
    // The registry's own message, which names what was asked for and what was
    // available. An `invalid_request`, because the client can fix it by
    // choosing — everything below is `internal_error` because it cannot.
    const message = e instanceof CharacterError ? e.message : String(e);
    return frameWithRid(commandFrame(cmd.name, { err: invalidRequest(message) }), rid);
  }

  const config = deps.registry.effectiveConfig(character);
  let engine: ConversationEngine;
  try {
    engine = await deps.registry.getOrCreate(character);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return frameWithRid(commandFrame(cmd.name, { err: internalError(message) }), rid);
  }

  const session = characterSession(deps, character, config);

  let frame: ServerMessage;
  try {
    const data = await runCommand(engine, session, deps.commands, cmd);
    const annotated = await afterCommand(cmd.name, cmd.args, data, {
      character,
      // The context's config *after* the command ran: `config` and the two
      // reloads mutate it in place, and it is the new value the post-processing
      // pushes outward.
      config: session.config,
      sessionId,
      rid,
      runtime: deps.dispatchRuntime,
      router: deps.router,
      handshake: deps.handshake,
    });
    frame = commandFrame(cmd.name, { ok: annotated });
  } catch (e) {
    frame = commandFrame(cmd.name, { err: e });
  }

  // Whatever the command did to the active model, the session remembers. Read
  // after the command, so `switch_model` and `reset_model` are reflected and a
  // command that failed leaves whatever the context was built with.
  deps.sessions.setActiveModel(sessionId, session.activeModel);
  return frameWithRid(frame, rid);
}

/**
 * A command that needs no character.
 *
 * The context is the *global* config, not a character's: there is no character
 * to merge one for, and a merged config here would let a per-character override
 * answer a question that was asked globally.
 */
async function characterlessCommand(
  deps: CommandPathDeps,
  cmd: Command,
  sessionId: number,
  rid: string | undefined,
): Promise<ServerMessage> {
  const session: CommandSession = {
    config: deps.globalConfig(),
    configPath: deps.configPath,
    dataDir: deps.dataDir,
    characterName: undefined,
    // Seeded from the session cache rather than resolved: with no character
    // there is nothing to resolve preferences against, and `list_models` still
    // wants to mark whatever the session last selected.
    activeModel: deps.sessions.activeModel(sessionId),
    activeResolvedModel: undefined,
    runtime: deps.runtime,
    ...(deps.env === undefined ? {} : { env: deps.env }),
  };

  let frame: ServerMessage;
  try {
    const data =
      cmd.name === "refresh_provider_models"
        ? await refreshProviderModels(session, deps, cmd)
        : runCharacterlessCommand(session, deps.commands, cmd);
    frame = commandFrame(cmd.name, { ok: data });
  } catch (e) {
    frame = commandFrame(cmd.name, { err: e });
  }

  // No mirroring here, and none is missing. The Rust wrote the context's
  // active model back after this path too, but `dispatch_characterless` took
  // the context by shared reference — nothing on that path could have changed
  // it, and nothing on this one does either. The write was a no-op with a line
  // of its own.
  return frameWithRid(frame, rid);
}

/**
 * The one characterless command the shared table does not carry.
 *
 * It is not in `runCharacterlessCommand` because it is not in the Rust's
 * `dispatch_characterless` either — that function is synchronous and this
 * command makes network calls. Routing it here keeps both tables matching
 * their Rust counterparts exactly, which is what the two fixtures check.
 */
async function refreshProviderModels(
  session: CommandSession,
  deps: CommandPathDeps,
  cmd: Command,
): Promise<unknown> {
  const { refreshProviderModels: refresh } = await import("../commands/providers.ts");
  return await refresh(
    {
      config: session.config,
      ...(deps.commands.fetchImpl === undefined ? {} : { fetchImpl: deps.commands.fetchImpl }),
    },
    (cmd.args ?? {}) as Args,
  );
}

/**
 * The character-scoped session, with its active model resolved from
 * preferences.
 *
 * Preferences are the durable source of truth, and the legacy
 * `runtime_state.json` is read underneath them by
 * {@link resolveActiveModelAndOverlay} — one release of migration so a
 * selection made before preferences existed survives the upgrade.
 *
 * The overlay that call also returns is dropped here on purpose: it belongs to
 * a *request*, and a command wants the model as it stands rather than as one
 * turn would send it.
 */
function characterSession(
  deps: CommandPathDeps,
  character: string,
  config: LoadedConfig,
): CommandSession {
  const { model } = resolveActiveModelAndOverlay(
    configView(config),
    character,
    (view, cacheDir, name, includeHidden) =>
      findEffectiveModel(view, cacheDir, name, includeHidden),
  );

  return {
    config,
    configPath: deps.configPath,
    dataDir: deps.dataDir,
    characterName: character,
    activeModel: model?.qualifiedName,
    activeResolvedModel: model,
    runtime: deps.runtime,
    ...(deps.env === undefined ? {} : { env: deps.env }),
  };
}

/**
 * Put the request's rid on the answer.
 *
 * On *every* path — see the module doc. The Rust did this on two of its three
 * and the third answered `null`.
 */
function frameWithRid(frame: ServerMessage, rid: string | undefined): ServerMessage {
  if (rid === undefined) return frame;
  if (frame.type === "command_output" || frame.type === "error") return { ...frame, rid };
  return frame;
}

export type { ReloadSummary };
