/**
 * What a client is told when it connects, and when it switches character.
 *
 * Ported from `crates/daemon/src/handshake.rs`.
 *
 * The transport already knows the *shape* of both snapshots —
 * `connection.ts` declares `HelloSnapshot` and `HistorySnapshot`, and ships a
 * `DEFAULT_HANDSHAKE` that answers with one character called `default` and an
 * empty history. This is the real answer: the characters actually on disk, and
 * the conversation actually in the engine.
 *
 * # Why the history snapshot is its own exported function
 *
 * Because it has three callers and only one of them is the handshake. A
 * character switch rebuilds it, and so does the command dispatcher after a
 * model change — both with an `activeModel` the caller already knows, which the
 * handshake does not have and has to resolve. The Rust shared one function for
 * exactly this reason and the two other call sites arrive with `handler/`.
 *
 * # The empty-history case is not an error
 *
 * A snapshot with no character selected, or with a character that has no
 * engine, is a real answer rather than a failure: it is what a client sees
 * before it has chosen, and what it sees when it names a character that has
 * gone. It still carries the config block, because the client renders the
 * active model from it either way.
 */

import type { CharacterInfo } from "../protocol/CharacterInfo";
import { characterMetadata } from "../commands/navigation.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { firstChatModel } from "../config/models.ts";
import { configView, resolveChatModelForCharacter } from "../config/preferences.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { HandshakeProvider, HelloSnapshot, HistorySnapshot } from "./connection";

/**
 * The slice of {@link CharacterRegistry} the handshake reads.
 *
 * Narrow on purpose: the Rust passed the whole registry behind a mutex because
 * that is how it shares one, and everything below reads four accessors. A test
 * needs those four and not a directory tree.
 */
export interface HandshakeRegistry {
  availableCharacters(): readonly string[];
  globalConfig(): LoadedConfig;
  effectiveConfig(name: string): LoadedConfig;
  getOrCreate(name: string): Promise<ConversationEngine>;
}

/** Answer both handshake snapshots from a live registry. */
export function buildHandshakeProvider(registry: HandshakeRegistry): HandshakeProvider {
  return {
    hello: () => Promise.resolve(helloSnapshot(registry)),
    // The handshake never knows the active model — nothing has selected one
    // yet — so it always resolves from preferences. The other two callers pass
    // the one they just set.
    history: async (selectedCharacter) =>
      await buildSessionHistorySnapshot(registry, selectedCharacter),
  };
}

/**
 * Every character, with its avatar bytes.
 *
 * The bytes travel rather than the path because a client cannot be assumed to
 * be able to read the daemon's config directory — it may not be on this
 * machine. `characterMetadata` carries that reasoning and the file probing.
 */
export function helloSnapshot(registry: HandshakeRegistry): HelloSnapshot {
  const configDir = registry.globalConfig().dirs.config;
  const characters: CharacterInfo[] = registry
    .availableCharacters()
    .map((name) => characterMetadata(configDir, name));
  return { characters };
}

/**
 * The conversation a client is given, plus the config block it renders from.
 *
 * `activeModel` is what the caller has already selected. Absent means resolve
 * it, which is the handshake's case: a fresh connection has selected nothing,
 * and the model shown has to be the one the next turn would actually use —
 * per-character preference first, then the legacy runtime-state file, then the
 * config default.
 */
export async function buildSessionHistorySnapshot(
  registry: HandshakeRegistry,
  selectedCharacter: string | null,
  activeModel?: string | undefined,
): Promise<HistorySnapshot> {
  const config =
    selectedCharacter === null
      ? registry.globalConfig()
      : registry.effectiveConfig(selectedCharacter);
  const resolvedModel = snapshotActiveModel(config, selectedCharacter, activeModel);
  const configBlock = historyConfigSnapshot(config, resolvedModel);

  // A character with no engine is not an error here. The Rust used `.ok()` on
  // `get_or_create`, and the only way it fails is a character that is not
  // available — a client naming one that has been deleted, which answers with
  // an empty conversation rather than a refused handshake.
  const engine = selectedCharacter === null ? undefined : await engineOrUndefined(registry, selectedCharacter);
  if (engine === undefined) {
    return {
      messages: [],
      activeStart: 0,
      config: configBlock,
      selectedCharacter: null,
      revision: 0,
    };
  }

  const history = engine.historySnapshot({});
  return {
    // Two spellings of one type. `engine/types.ts` widens `tool_result.content`
    // to allow blocks, because the generated-image replay path returns an image
    // plus a caption and the generated `protocol/ContentBlock.ts` — like the
    // Rust it was generated from — says `string`. The engine's note calls that
    // "simply wrong for that path", so the wider one is what actually flows and
    // the cast is where the two meet. `connection.ts` already carries the same
    // one on its way into the frame.
    messages: history.messages as HistorySnapshot["messages"],
    // Push and handshake snapshots carry active context only, so the index is
    // zero and `historySnapshot` leaves it unset. Only the bounded log/history
    // responses put scrollback in front of it.
    activeStart: history.active_start ?? 0,
    config: configBlock,
    // The engine's own name, not the requested one. They agree today; taking
    // it from the engine is what the Rust did, and it is the one that has been
    // resolved.
    selectedCharacter: history.selected_character ?? null,
    revision: history.revision,
  };
}

async function engineOrUndefined(
  registry: HandshakeRegistry,
  character: string,
): Promise<ConversationEngine | undefined> {
  try {
    return await registry.getOrCreate(character);
  } catch {
    return undefined;
  }
}

/**
 * The `config` block, which currently holds one key.
 *
 * The fallback chain is the Rust's and it bottoms out at the catalog rather
 * than at nothing: a config with no `defaults.model` still has a first chat
 * model, and showing that beats showing a client a blank where its model name
 * goes.
 */
function historyConfigSnapshot(config: LoadedConfig, activeModel: string | undefined): unknown {
  return {
    active_model:
      activeModel ?? config.app.defaults.model ?? firstChatModel(config.models)?.qualifiedName ?? null,
  };
}

/**
 * The model a snapshot reports when the caller did not name one.
 *
 * Only reached with a character selected: with none, there are no per-character
 * preferences to resolve and the config default is the answer, which
 * {@link historyConfigSnapshot} supplies on its own.
 *
 * A preferences file that will not read is a warning and empty defaults rather
 * than a failure — `resolveChatModelForCharacter` carries that, along with the
 * legacy `active_model` file the chain still consults. Its warning text says
 * `resolve_chat_model` where the Rust's said "handshake snapshot"; the
 * resolution is the same, and one shared resolver beats two spellings of it.
 */
function snapshotActiveModel(
  config: LoadedConfig,
  selectedCharacter: string | null,
  activeModel: string | undefined,
): string | undefined {
  if (activeModel !== undefined) return activeModel;
  if (selectedCharacter === null) return undefined;
  return resolveChatModelForCharacter(configView(config), selectedCharacter, findEffectiveModel)
    ?.qualifiedName;
}
