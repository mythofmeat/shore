/**
 * Deferred prompt edits — the rule that editing SOUL.md does not change the
 * prompt until the next compaction boundary.
 *
 * Ported from `crates/daemon/src/memory/deferred_edits.rs`, pinned by
 * `tests/memory_fixtures/deferred_edits_parity.json`.
 *
 * # Why a snapshot exists at all
 *
 * The canonical prompt-visible files live in the config workspace and a user
 * (or a tool call) may edit them at any moment. The prompt cannot follow them
 * live: Anthropic's prefix cache is keyed on exact bytes, so a mid-conversation
 * change to SOUL.md would invalidate the prefix for every subsequent turn. So
 * the daemon keeps a snapshot under `active_prompt/`, serves the prompt from
 * that, and only re-copies at a boundary where the prefix is being rebuilt
 * anyway.
 *
 * `deferred_edits.jsonl` is the queue of edits waiting for such a boundary.
 * Ownership of that file moves to TypeScript here, per #12.
 *
 * # Blank is missing
 *
 * Every read in this module filters whitespace-only content down to absent,
 * and `changedPromptFiles` compares those filtered values — so a file that
 * goes from missing to blank is *not* a change. Between two non-blank
 * versions, though, any byte difference counts, trailing newline included.
 * Both halves are pinned; the asymmetry is deliberate in the Rust and it is
 * the prefix cache that motivates it.
 *
 * The path-normalisation helpers this module used to own were ported earlier
 * and live in `tools/workspace_path.ts`.
 */

import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  appendFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  characterConfigDir,
  characterMemoryDir,
  characterWorkspaceDir,
  characterWorkspaceFile,
} from "../config/dirs.ts";

import {
  activePromptDir,
  activePromptFile,
  normalizePromptVisiblePath,
} from "../tools/workspace_path";
import { localRfc3339 } from "../time.ts";

/** Workspace-root files that are editable now but prompt-active only later. */
const PROTECTED_PATHS = ["SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md"] as const;

/**
 * The memory index, under the one name it has.
 *
 * The Rust carried two constants here — `MEMORY_INDEX_FILE` for the file on
 * disk and `MEMORY_INDEX_DEFERRED_PATH` for the path a deferred edit names —
 * and branched on the difference in two places: which file to copy from, and
 * what to call the snapshot. Both are `"MEMORY.md"`, so neither branch was
 * reachable, which mutation testing showed by leaving them unkillable.
 * Collapsed to one name. If the index ever needs a distinct on-disk name, the
 * split goes back into `canonicalFile` and the snapshot naming, and the
 * fixture needs a case where the two differ.
 */
export const MEMORY_INDEX_FILE = "MEMORY.md";

const QUEUE_FILE = "deferred_edits.jsonl";

/**
 * Snapshots left behind by prompt files that no longer exist: the pre-rename
 * `<recent_memory>` block, and `HEARTBEAT.md` from before heartbeat
 * carry-forward folded into `MEMORY.md`. Removed opportunistically when the
 * snapshot directory is re-seeded, so they do not accumulate forever.
 */
const LEGACY_SNAPSHOTS = ["RECENT_MEMORY.md", "HEARTBEAT.md"];

const DEFAULT_TOOLS_GUIDANCE = `# TOOLS

Use tools when they materially help.

- Read files before editing them.
- Search memory files before guessing facts about the user or past events.
- Prefer concise, direct tool use over busywork.
`;

// --- config layout ---------------------------------------------------------
//
// These four were private copies here until `config/dirs.ts` landed the layout
// they duplicate. They now come from there, so a change to where a character's
// files live is made once. The shared versions join like `PathBuf::push` rather
// than like `node:path`, which differs only for a character name that is
// absolute or carries redundant separators — the frozen fixture below uses
// neither, and still passes unchanged.

export const memoryIndexPath = (configDir: string, charName: string) =>
  join(characterWorkspaceDir(configDir, charName), MEMORY_INDEX_FILE);

// --- small fs helpers ------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Content of a file if it is present and not blank, else undefined.
 *
 * Mirrors the Rust's `read_to_string(..).ok().filter(non-blank)` — note that
 * an unreadable file is indistinguishable from a missing one here. That is
 * load-bearing at every call site: a permissions error on SOUL.md degrades to
 * "no soul" rather than failing the turn.
 */
async function effectiveContent(p: string): Promise<string | undefined> {
  try {
    const content = await readFile(p, "utf8");
    return content.trim() === "" ? undefined : content;
  } catch {
    return undefined;
  }
}

/**
 * The canonical source a prompt-visible path is copied from. The memory index
 * needs no special case: `memoryIndexPath` resolves to exactly this, since
 * both live at the workspace root. See MEMORY_INDEX_FILE.
 */
const canonicalFile = (configDir: string, charName: string, path: string) =>
  characterWorkspaceFile(configDir, charName, path);

// --- reads -----------------------------------------------------------------

/** Snapshot content for a prompt file, or undefined if absent or blank. */
export const loadActivePromptFile = (characterDataDir: string, name: string) =>
  effectiveContent(activePromptFile(characterDataDir, name));

/** Canonical memory index, ignoring any snapshot. */
export const loadCanonicalMemoryIndex = (configDir: string, charName: string) =>
  effectiveContent(memoryIndexPath(configDir, charName));

/**
 * Memory index as the prompt should see it.
 *
 * The snapshot wins when it *exists*, even if blank — a blank snapshot is the
 * sentinel meaning "an edit is queued, keep showing nothing until it applies",
 * so falling through to canonical there would defeat the deferral. Only a
 * genuinely absent snapshot reads canonical. Pinned by the case named
 * "does NOT fall through when the snapshot is blank".
 */
export async function loadMemoryIndex(
  characterDataDir: string,
  configDir: string,
  charName: string,
): Promise<string | undefined> {
  const active = activePromptFile(characterDataDir, MEMORY_INDEX_FILE);
  if (await exists(active)) return effectiveContent(active);
  return effectiveContent(memoryIndexPath(configDir, charName));
}

/**
 * Prompt-visible paths waiting for activation, deduplicated and sorted.
 *
 * Sorted because the Rust collected into a `BTreeSet`, so callers see
 * alphabetical order rather than the order edits arrived. Unparseable lines,
 * lines without a string `path`, and paths that are not prompt-visible are all
 * skipped rather than failing the read — a corrupt queue must not be able to
 * block a compaction boundary.
 */
export async function pendingDeferredEditPaths(
  characterDataDir: string,
): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(join(characterDataDir, QUEUE_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const paths = new Set<string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const raw = (entry as Record<string, unknown>).path;
    if (typeof raw !== "string") continue;
    const normalized = normalizePromptVisiblePath(raw);
    if (normalized !== undefined) paths.add(normalized);
  }
  return [...paths].sort();
}

// --- writes ----------------------------------------------------------------

/**
 * Queue a deferred refresh. A path that is not prompt-visible is silently
 * ignored — most workspace writes are ordinary memory files and must not
 * enqueue anything.
 */
export async function queueDeferredEdit(
  characterDataDir: string,
  requestedPath: string,
): Promise<void> {
  const path = normalizePromptVisiblePath(requestedPath);
  if (path === undefined) return;

  await mkdir(characterDataDir, { recursive: true });

  // A first-ever memory index needs an empty snapshot file to exist, or
  // `loadMemoryIndex` would fall through to the canonical copy and activate
  // the very edit being deferred.
  if (path === MEMORY_INDEX_FILE) {
    const sentinel = activePromptFile(characterDataDir, MEMORY_INDEX_FILE);
    if (!(await exists(sentinel))) {
      await mkdir(activePromptDir(characterDataDir), { recursive: true });
      await writeFile(sentinel, "", "utf8");
    }
  }

  const line = JSON.stringify({ path, timestamp: localRfc3339(new Date()) });
  await appendFile(join(characterDataDir, QUEUE_FILE), `${line}\n`, "utf8");
}

/** Queue a deferred refresh of the memory index. */
export const noteMemoryIndexDeferred = (characterDataDir: string) =>
  queueDeferredEdit(characterDataDir, MEMORY_INDEX_FILE);

/**
 * Which prompt-visible files would change if the snapshot were refreshed now.
 *
 * Order follows the protected list with the memory index last, not the
 * alphabetical order `pendingDeferredEditPaths` returns. The two functions
 * answer different questions — what *would* change versus what was *asked* to
 * change — and the fixture pins both orders.
 */
export async function changedPromptFiles(
  characterDataDir: string,
  configDir: string,
  charName: string,
): Promise<string[]> {
  const changed: string[] = [];
  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    const canonical = await effectiveContent(
      canonicalFile(configDir, charName, path),
    );
    const active = await effectiveContent(
      activePromptFile(characterDataDir, path),
    );
    if (canonical !== active) changed.push(path);
  }
  return changed;
}

/**
 * Copy one canonical file into the snapshot.
 *
 * `seedOnly` is the difference between "make sure something is there" and
 * "make it current". The third branch is the interesting one: on a refresh,
 * a canonical file that has been *deleted* removes the snapshot too, so
 * deleting SOUL.md eventually takes it out of the prompt. On a seed it does
 * not, because a seed must never destroy a snapshot it did not create.
 */
async function copyPromptVisibleFile(
  characterDataDir: string,
  configDir: string,
  charName: string,
  path: string,
  seedOnly: boolean,
): Promise<void> {
  const activeDir = activePromptDir(characterDataDir);
  await mkdir(activeDir, { recursive: true });

  const src = canonicalFile(configDir, charName, path);
  const dst = join(activeDir, path);

  if (seedOnly && (await exists(dst))) return;

  if (await exists(src)) {
    await copyFile(src, dst);
  } else if (await exists(dst)) {
    // Only reachable on a refresh: the early return above already took the
    // seeding case with a snapshot present.
    await rm(dst);
  }
}

/**
 * Create the workspace-first layout and migrate anything left by the older
 * per-character config layout into it.
 *
 * Every step is "copy if the destination is missing" — never overwrite. A
 * character that has already been migrated must survive this being run again
 * on every snapshot check, which it is.
 */
export async function ensureCharacterWorkspace(
  characterDataDir: string,
  configDir: string,
  charName: string,
): Promise<void> {
  const charConfigDir = characterConfigDir(configDir, charName);
  const workspaceDir = characterWorkspaceDir(configDir, charName);
  const memoryDir = characterMemoryDir(configDir, charName);

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  await migrateLegacyFile(
    join(charConfigDir, "character.md"),
    join(workspaceDir, "SOUL.md"),
  );
  await migrateLegacyFile(
    join(charConfigDir, "user.md"),
    join(workspaceDir, "USER.md"),
  );
  await migrateLegacyFile(
    join(charConfigDir, "prompts", "system.md"),
    join(workspaceDir, "AGENTS.md"),
  );

  // A global user.md seeds a character that has none of its own.
  const globalUser = join(configDir, "user.md");
  const workspaceUser = join(workspaceDir, "USER.md");
  if ((await exists(globalUser)) && !(await exists(workspaceUser))) {
    await copyFile(globalUser, workspaceUser);
  }

  if (!(await exists(join(workspaceDir, "TOOLS.md")))) {
    await writeFile(join(workspaceDir, "TOOLS.md"), DEFAULT_TOOLS_GUIDANCE, "utf8");
  }

  const legacyMemories = join(characterDataDir, "memories");
  if (await exists(legacyMemories)) {
    await copyTreeIfMissing(legacyMemories, memoryDir);
  }
}

/**
 * Make sure a snapshot exists, without disturbing one that already does —
 * this runs on ordinary turns, so it must not activate a pending edit.
 */
export async function ensureActivePromptSnapshot(
  characterDataDir: string,
  configDir: string,
  charName: string,
): Promise<void> {
  await ensureCharacterWorkspace(characterDataDir, configDir, charName);

  const activeDir = activePromptDir(characterDataDir);
  await mkdir(activeDir, { recursive: true });

  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    await copyPromptVisibleFile(characterDataDir, configDir, charName, path, true);
  }

  for (const legacy of LEGACY_SNAPSHOTS) {
    const p = join(activeDir, legacy);
    if (await exists(p)) await rm(p);
  }
}

/** Re-copy every prompt-visible file, activating whatever has changed. */
export async function refreshActivePromptSnapshot(
  characterDataDir: string,
  configDir: string,
  charName: string,
): Promise<void> {
  await ensureCharacterWorkspace(characterDataDir, configDir, charName);
  for (const path of [...PROTECTED_PATHS, MEMORY_INDEX_FILE]) {
    await copyPromptVisibleFile(characterDataDir, configDir, charName, path, false);
  }
}

/** Refresh the snapshot and clear the queue — the compaction boundary. */
export async function applyDeferredEdits(
  characterDataDir: string,
  configDir: string,
  charName: string,
): Promise<void> {
  await refreshActivePromptSnapshot(characterDataDir, configDir, charName);
  await rm(join(characterDataDir, QUEUE_FILE), { force: true });
}

async function migrateLegacyFile(src: string, dst: string): Promise<void> {
  if ((await exists(src)) && !(await exists(dst))) {
    await copyFile(src, dst);
  }
}

/** Recursive copy that never overwrites an existing destination file. */
async function copyTreeIfMissing(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyTreeIfMissing(srcPath, dstPath);
    } else if (!(await exists(dstPath))) {
      await copyFile(srcPath, dstPath);
    }
  }
}
