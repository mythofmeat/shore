/**
 * The character half of the SWP command surface: which characters exist, what
 * one is made of, and validating a request to switch.
 *
 * Ported from `crates/daemon/src/commands/navigation.rs`, pinned by
 * `tests/commands_fixtures/navigation_parity.json`.
 *
 * # Existing and being a character are different questions
 *
 * `discoverCharacters` requires a marker file — `workspace/SOUL.md` or the
 * legacy `character.md` — so a bare directory under `characters/` is not a
 * character and never appears in a listing. But {@link characterInfo} and
 * {@link switchCharacter} both gate on the directory *existing*, so both answer
 * for a name the listing would never have offered. That is the Rust's, and it
 * is pinned rather than fixed: the two commands are how a client bootstraps a
 * character directory that does not have its `SOUL.md` yet.
 *
 * # No `CommandContext`, no engine
 *
 * The Rust threaded a whole `&ConversationEngine` through three of these four
 * functions and read exactly one thing from it — `character_name()`. It is a
 * string parameter here. `&CommandContext` went the same way: what these
 * commands actually need is the config directory, and in one case the data
 * directory, so that is what they take.
 */

import { readFileSync } from "node:fs";

import {
  AGENTS_FILE,
  SOUL_FILE,
  TOOLS_FILE,
  USER_FILE,
  characterConfigDir,
  characterDataDir,
  characterWorkspaceDir,
  characterWorkspaceFile,
  discoverCharacters,
  isFile,
  pathExists,
  readOrUndefined,
  rustJoin,
} from "../config/dirs.ts";
import { pendingDeferredEditPaths } from "../memory/deferred_edits.ts";
import type { CharacterInfo } from "../protocol/CharacterInfo.ts";
import { invalidRequest, notFound } from "./errors.ts";

/** Args arrive as a decoded JSON object; every field is optional and untyped. */
export type Args = Record<string, unknown>;

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// ── avatars ───────────────────────────────────────────────────────────────

/** Probed in order; the first that is a readable, non-empty file wins. */
const AVATARS: readonly (readonly [file: string, mimeType: string])[] = [
  ["avatar.png", "image/png"],
  ["avatar.jpg", "image/jpeg"],
  ["avatar.jpeg", "image/jpeg"],
  ["avatar.webp", "image/webp"],
];

/**
 * A character's name and, if one is on disk, its avatar inlined as base64.
 *
 * Shared with the handshake, which sends it in the server hello — the clients
 * cannot be assumed to be able to read the daemon's config directory, which is
 * why the bytes travel rather than the path.
 *
 * A zero-byte file is skipped and the probe continues, so a truncated avatar
 * falls through to the next extension instead of being sent as an image with no
 * data. Nothing here checks that the character exists.
 */
export function characterMetadata(configDir: string, name: string): CharacterInfo {
  for (const [file, mimeType] of AVATARS) {
    const path = rustJoin(characterConfigDir(configDir, name), file);
    // The probe and the catch below are mutually redundant, and both are
    // knowingly kept. Anything that is not a readable file — missing, a
    // directory, a dangling symlink — fails the read too, so either one alone
    // produces every answer this function can give, and no mutant that removes
    // one can be killed. The probe stays because not-having-an-avatar is the
    // common case and a `stat` says so more cheaply and more plainly than a
    // thrown `EISDIR`; the catch stays because it is the only thing standing
    // between a permissions error and a failed handshake.
    if (!isFile(path)) continue;
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      continue;
    }
    if (data.length === 0) continue;
    return { name, avatar: { mime_type: mimeType, data: data.toString("base64") } };
  }
  return { name };
}

// ── listings ──────────────────────────────────────────────────────────────

/**
 * The characters a client may choose between.
 *
 * With an `active` character it leads the list unconditionally — it is
 * prepended before discovery runs and deduplicated out of the discovered
 * names, so it appears first even when it sorts last, and appears at all when
 * it has nothing on disk. Without one the answer is discovery alone, in sorted
 * order, and an empty directory really is an empty list.
 *
 * The Rust had these as two functions because one took the engine and the other
 * could not; here the difference is the whole of it.
 */
export function listCharacters(
  configDir: string,
  active?: string,
  workspaceRoot?: string | undefined,
): { characters: CharacterInfo[] } {
  const characters = active === undefined ? [] : [characterMetadata(configDir, active)];
  for (const name of discoverCharacters(configDir, workspaceRoot)) {
    if (name !== active) characters.push(characterMetadata(configDir, name));
  }
  return { characters };
}

/** The listing with no session attached — used before a character is resolved. */
export const listCharactersStandalone = (
  configDir: string,
  workspaceRoot?: string | undefined,
): { characters: CharacterInfo[] } => listCharacters(configDir, undefined, workspaceRoot);

// ── character_info ────────────────────────────────────────────────────────

/** How much of `SOUL.md` the preview carries, in characters. */
const PREVIEW_CHARS = 500;

export interface CharacterInfoContext {
  /** `$XDG_CONFIG_HOME/shore/` — where `characters/` lives. */
  configDir: string;
  /** `$XDG_DATA_HOME/shore/` — where per-character runtime state lives. */
  dataDir: string;
  /** The session's character, used when the request names none. */
  active: string;
  /** `SHORE_WORKSPACE_DIR`, when workspaces live outside the config tree. */
  workspaceRoot?: string | undefined;
}

/**
 * What a character is made of: its directories, its bootstrap files, and what
 * is queued to be activated into its prompt.
 *
 * Two fields answer the same question differently on purpose.
 * `has_definition` is whether `SOUL.md` is *there*; `definition_preview` is
 * whether it could be *read*. A `SOUL.md` that is a directory reports present
 * with a null preview, and an empty one reports present with an empty preview.
 *
 * A queue that cannot be read reports nothing pending rather than failing:
 * `character_info` is what a client calls to find out why a character is
 * misbehaving, and a corrupt queue must not be the thing that stops it
 * answering.
 */
export async function characterInfo(ctx: CharacterInfoContext, args: Args): Promise<unknown> {
  const requested = asStr(args["name"]);
  const name = requested === undefined || requested === "" ? ctx.active : requested;

  const charDir = characterConfigDir(ctx.configDir, name);
  if (!pathExists(charDir) && name !== ctx.active) {
    throw notFound(`Character not found: ${name}`);
  }

  const workspaceDir = characterWorkspaceDir(ctx.configDir, name);
  const definitionPath = characterWorkspaceFile(ctx.configDir, name, SOUL_FILE);
  const hasDefinition = pathExists(definitionPath);
  const definition = hasDefinition ? readOrUndefined(definitionPath) : undefined;

  const dataDir = characterDataDir(ctx.dataDir, name);
  // `unwrap_or_default()` on the Rust side.
  const pending = await pendingDeferredEditPaths(dataDir).catch(() => []);

  return {
    name,
    active: name === ctx.active,
    config_dir: charDir,
    workspace_dir: workspaceDir,
    has_definition: hasDefinition,
    // `chars().take(500)`: Unicode scalar values, so the spread and not
    // `slice`, which would count UTF-16 units and cut an astral character in
    // half at the boundary.
    definition_preview: definition === undefined ? null : [...definition].slice(0, PREVIEW_CHARS).join(""),
    bootstrap_files: [SOUL_FILE, USER_FILE, AGENTS_FILE, TOOLS_FILE].filter((file) =>
      pathExists(characterWorkspaceFile(ctx.configDir, name, file)),
    ),
    has_config_override: pathExists(rustJoin(charDir, "config.toml")),
    pending_deferred_edits: pending,
    data_dir: dataDir,
    has_data: pathExists(dataDir),
  };
}

// ── switch_character ──────────────────────────────────────────────────────

/**
 * Validate a request to switch characters. The registry performs the switch;
 * this only says whether it can.
 *
 * The same-name check runs before the directory probe, so staying put succeeds
 * for a character with nothing on disk.
 */
export function switchCharacter(configDir: string, active: string, args: Args): unknown {
  const name = asStr(args["name"]);
  if (name === undefined) throw invalidRequest("Missing required argument: name");

  if (name === active) return { character: name, changed: false };

  if (!pathExists(characterConfigDir(configDir, name))) {
    throw notFound(`Character not found: ${name}`);
  }
  return { character: name, changed: true };
}
