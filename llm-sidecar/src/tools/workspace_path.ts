/**
 * Workspace path confinement.
 *
 * Ported from `resolve_roots` / `resolve_path` in
 * `crates/daemon/src/tools/workspace.rs` and the prompt-visible normalization
 * in `crates/daemon/src/memory/deferred_edits.rs`, pinned by
 * `tests/engine_fixtures/subagent_parity.json`.
 *
 * Every filesystem-touching tool routes its caller-supplied path through
 * {@link resolvePath} first. It is the single boundary that keeps a model —
 * or anything a model was persuaded to emit — from naming a file outside the
 * character's workspace. Three separate escapes are refused:
 *
 * 1. **Absolute paths.** `path.join(base, "/etc/passwd")` in Node happens to
 *    keep the base, but Rust's `Path::join` discards it outright and would
 *    have read the file. The component scan rejects the input either way, so
 *    neither language's join semantics are load-bearing.
 * 2. **`..` traversal.** Rejected on the *unnormalized* components, so
 *    `sub/../SOUL.md` is refused even though it names a file that is in fact
 *    inside the workspace. Refusing the shape rather than the destination is
 *    what makes the rule auditable.
 * 3. **Symlinks out.** A link with no `..` and no leading `/` looks clean and
 *    only shows itself once resolved, so the resolved path is compared
 *    against the resolved base.
 *
 * The comparison is done on *resolved* paths on both sides. Comparing the
 * literal strings would be defeated by any of `..`, a symlinked workspace
 * root, or a `/tmp` → `/private/tmp` style platform alias.
 *
 * `pathComponents` and `isInside` — the two pieces of the rule that are not
 * about *this* base directory — are exported for `memory/markdown_store.ts`,
 * which confines the markdown memory store the same way.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, sep } from "node:path";

/** A rejected path, carrying the same message the Rust `ToolError` rendered. */
export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/** Workspace files that are prompt-visible and therefore snapshotted. */
const PROTECTED_PATHS = ["SOUL.md", "USER.md", "AGENTS.md", "TOOLS.md"] as const;

/** The prompt-visible memory index, snapshotted alongside the protected files. */
const MEMORY_INDEX_DEFERRED_PATH = "MEMORY.md";

/** Snapshot directory under the character data dir. */
const ACTIVE_PROMPT_DIR = "active_prompt";

/**
 * Split a caller path into its base directory and the part below it.
 *
 * `workspace/` and `memory/` are *prefixes the caller may use*, not real
 * leading directories — `memory/note.md` lands at `<ws>/memory/note.md` while
 * `workspace/SOUL.md` lands at `<ws>/SOUL.md`. Everything else is taken
 * relative to the workspace root.
 *
 * @throws {PathError} when the workspace is unconfigured or the path is blank.
 */
export function resolveRoots(workspaceDir: string, relativeRaw: string): [string, string] {
  if (workspaceDir === "") throw new PathError("invalid args: workspace not configured");

  const relative = relativeRaw.trim();
  if (relative === "") throw new PathError("invalid args: path is empty");

  if (relative === "workspace") return [workspaceDir, ""];
  if (relative.startsWith("workspace/")) return [workspaceDir, relative.slice("workspace/".length)];
  if (relative === "memory") return [rustJoin(workspaceDir, "memory"), ""];
  if (relative.startsWith("memory/")) {
    return [rustJoin(workspaceDir, "memory"), relative.slice("memory/".length)];
  }
  return [workspaceDir, relative];
}

/**
 * Rust's `Path::join`: append with a separator, verbatim.
 *
 * Node's `path.join` normalizes as it goes — it would collapse `./` and, more
 * to the point, resolve `..` against the base. Nothing downstream should see a
 * path whose `..` has been silently reinterpreted, so the concatenation stays
 * literal and the component scan above stays the only thing that judges it.
 */
function rustJoin(base: string, child: string): string {
  if (base === "") return child;
  return base.endsWith(sep) ? base + child : `${base}${sep}${child}`;
}

/**
 * Resolve a caller-supplied path against the workspace, refusing anything that
 * leaves it.
 *
 * A path naming a file that does not exist yet still resolves — `write` needs
 * that. Confinement is checked against the nearest ancestor that *does* exist,
 * so a missing file cannot be used to skip the check.
 *
 * @throws {PathError} on an empty path, `..`, an absolute path, or a resolved
 * path outside the workspace.
 */
export function resolvePath(workspaceDir: string, relative: string): string {
  const [base, stripped] = resolveRoots(workspaceDir, relative);
  // A bare `workspace` or `memory` names the directory, not a file in it.
  if (stripped === "") throw new PathError("invalid args: path is empty");

  for (const component of pathComponents(stripped)) {
    if (component === "..") {
      throw new PathError("invalid args: path traversal (..) is not allowed");
    }
    if (component === "/") {
      throw new PathError("invalid args: absolute paths are not allowed");
    }
  }

  const resolved = rustJoin(base, stripped);

  // An unresolvable base means the workspace itself is missing; the Rust let
  // that through rather than inventing a failure, and `write` relies on it.
  const canonicalBase = tryRealpath(base);
  if (canonicalBase === undefined) return resolved;

  const canonical = tryRealpath(resolved);
  if (canonical !== undefined) {
    if (!isInside(canonical, canonicalBase)) {
      throw new PathError("invalid args: resolved path escapes workspace");
    }
    return resolved;
  }

  // The target does not exist yet. Walk up to the first ancestor that does and
  // check *that* — a symlinked parent directory escapes just as effectively as
  // a symlinked file.
  let ancestor = resolved;
  for (;;) {
    const parent = parentOf(ancestor);
    if (parent === undefined) break;
    const canonicalParent = tryRealpath(parent);
    if (canonicalParent !== undefined) {
      if (!isInside(canonicalParent, canonicalBase)) {
        throw new PathError("invalid args: resolved path escapes workspace");
      }
      break;
    }
    ancestor = parent;
  }

  return resolved;
}

/**
 * Split the way Rust's `Path::components` does: a leading separator becomes a
 * distinct root component, and `.` segments and empty runs are dropped. `..`
 * is deliberately *not* collapsed — the caller rejects it, and collapsing
 * first would silently accept `sub/../..`.
 *
 * Backslash counts as a separator here, which the Rust's unix build does not
 * do. That is deliberate and one-directional: it can only cause more paths to
 * be refused, never fewer, and a filename containing a literal backslash is
 * not worth the ambiguity at a confinement boundary.
 *
 * Exported for `memory/markdown_store.ts`, which confines against a different
 * base and reports different messages but applies the same rule. Two copies of
 * this would be two chances to get it wrong.
 */
export function pathComponents(p: string): string[] {
  const out: string[] = [];
  if (isAbsolute(p)) out.push("/");
  for (const part of p.split(/[/\\]/)) {
    if (part === "" || part === ".") continue;
    out.push(part);
  }
  return out;
}

/**
 * Containment on resolved paths, compared by path *component* rather than by
 * string prefix. `startsWith` would accept `/ws-secrets` as living inside
 * `/ws`, which is exactly the kind of near-miss this boundary exists to stop.
 */
export function isInside(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  const withSep = base.endsWith(sep) ? base : base + sep;
  return candidate.startsWith(withSep);
}

/** The parent directory, or `undefined` at the filesystem root. */
function parentOf(p: string): string | undefined {
  const parent = dirname(p);
  if (parent === p) return undefined;
  // `dirname` of a bare relative name yields ".", which has no parent of its own.
  if (parent === "." && parse(p).dir === "") return undefined;
  return parent;
}

/** `realpath`, or `undefined` when the path does not resolve. */
function tryRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

// ── Prompt-visible files ────────────────────────────────────────────────

/**
 * Strip the leading separators, `./` runs and `workspace/` prefixes a caller
 * may have written, until none apply.
 *
 * The loop is not decoration: a single pass let `workspace/./SOUL.md` and
 * `./workspace/SOUL.md` through, because whichever prefix was checked first
 * left the other in place — and a path that fails to normalize is a path the
 * protected-file guard does not recognize.
 */
export function normalizeWorkspacePath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/");
  for (;;) {
    const before = normalized.length;
    while (normalized.startsWith("/")) normalized = normalized.slice(1);
    while (normalized.startsWith("./")) normalized = normalized.slice(2);
    if (normalized.startsWith("workspace/")) normalized = normalized.slice("workspace/".length);
    if (normalized.length === before) break;
  }
  return normalized;
}

/** The canonical name of a protected workspace file, if `path` names one. */
export function normalizeProtectedPath(path: string): string | undefined {
  const normalized = normalizeWorkspacePath(path);
  return (PROTECTED_PATHS as readonly string[]).includes(normalized) ? normalized : undefined;
}

/**
 * The canonical name of a prompt-visible file, if `path` names one.
 *
 * Keying the snapshot lookup on this — rather than on the caller's spelling —
 * is what stops a dressed-up traversal from selecting a snapshot file: only
 * the fixed set of names can ever match, so the lookup's argument is never
 * attacker-chosen.
 */
export function normalizePromptVisiblePath(path: string): string | undefined {
  const normalized = normalizeWorkspacePath(path);
  const protectedName = normalizeProtectedPath(normalized);
  if (protectedName !== undefined) return protectedName;
  if (normalized === MEMORY_INDEX_DEFERRED_PATH) return MEMORY_INDEX_DEFERRED_PATH;
  return undefined;
}

/** The active-prompt snapshot directory for a character. */
export function activePromptDir(characterDataDir: string): string {
  return join(characterDataDir, ACTIVE_PROMPT_DIR);
}

/** A single file inside the active-prompt snapshot. */
export function activePromptFile(characterDataDir: string, name: string): string {
  return join(activePromptDir(characterDataDir), name);
}
