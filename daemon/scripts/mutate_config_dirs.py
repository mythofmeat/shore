#!/usr/bin/env python3
"""Mutation pass over the config dirs/loader port (#18 / #12).

#12 requires every parity fixture be mutation-checked, on the evidence that
five ports in a row had a fixture replay green while still full of holes. This
is the harness for `config/dirs.ts` and `config/loader.ts`.

Each entry is a single textual edit that inverts one decision in the port. A
mutant is KILLED if `bun test tests/dirs.test.ts` fails with it applied;
a survivor means either the fixture cannot see that decision, or the code is
equivalent under it. The first pass here was 35/52 and the survivors were the
useful output: two functions with no coverage at all, several conf.d cases
passing vacuously on a shared key, and three branches that turned out to be
unreachable and were deleted. Final state is 46/49 with three documented
equivalents, each noted at its site in the source.

Run from the repository root:
    python3 daemon/scripts/mutate_config_dirs.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIRS = ROOT / "src/config/dirs.ts"
LOAD = ROOT / "src/config/loader.ts"

# (file, label, find, replace)
MUTANTS = [
    # --- rustJoin ---------------------------------------------------------
    (DIRS, "rustJoin: absolute component no longer replaces",
     'if (part.startsWith("/")) {\n      out = part;', 'if (false) {\n      out = part;'),
    (DIRS, "rustJoin: always treat component as absolute",
     'if (part.startsWith("/")) {', 'if (true) {'),
    (DIRS, "rustJoin: drop the trailing-separator guard",
     '} else if (out === "" || out.endsWith("/")) {', '} else if (false) {'),
    (DIRS, "rustJoin: drop the empty-base guard",
     'out === "" || out.endsWith("/")', 'out.endsWith("/")'),
    (DIRS, "rustJoin: normalize like node join",
     'out += `/${part}`;', 'out = join(out, part);'),
    # --- xdg resolution ---------------------------------------------------
    (DIRS, "xdgOrHome: treat empty HOME as usable",
     'env.HOME !== undefined && env.HOME !== "" ? env.HOME : home()',
     'env.HOME !== undefined ? env.HOME : home()'),
    (DIRS, "resolveXdgDir: runtime consults the platform lookup (EQUIVALENT — the "
     "platform lookup only runs when $XDG_RUNTIME_DIR is unset, which is the one "
     "case where reading it returns undefined too)",
     "runtime: () => undefined,",
     "runtime: (env) => env.XDG_RUNTIME_DIR,"),
    (DIRS, "xdgOrHome: skip the passwd fallback",
     'env.HOME !== undefined && env.HOME !== "" ? env.HOME : home()', 'env.HOME'),
    (DIRS, "resolveXdgDir: platform lookup wins over the raw XDG var",
     "  let base = xdg ?? platform(env, home);",
     "  let base = platform(env, home) ?? xdg;"),
    (DIRS, "resolveXdgDir: ignore the SHORE_* override",
     'if (override !== undefined) return override;', 'if (false) return override;'),
    (DIRS, "resolveXdgDir: append /shore to the SHORE_* override too",
     'if (override !== undefined) return override;',
     'if (override !== undefined) return rustJoin(override, "shore");'),
    (DIRS, "resolveXdgDir: an unresolvable home raises instead of falling back",
     '    if (lastResort === "temp_dir") {',
     "    if (false as boolean) {"),
    (DIRS, "resolveXdgDir: always fall back to the temp dir, never raising",
     '    if (lastResort === "temp_dir") {',
     "    if (true as boolean) {"),
    (DIRS, "resolveXdgDir: drop the /shore suffix",
     'return rustJoin(base, "shore");', 'return base;'),
    # --- discovery --------------------------------------------------------
    (DIRS, "discoverCharacters: sort in UTF-16 order",
     "  return [...names].sort(compareByCodePoint);",
     "  return [...names].sort();"),
    (DIRS, "discoverCharacters: do not sort at all",
     "  return [...names].sort(compareByCodePoint);",
     "  return [...names];"),
    (DIRS, "discoverCharacters: require both SOUL.md and the legacy file",
     "      (workspaceRoot === undefined &&\n"
     "        pathExists(join(dir, CHARACTER_WORKSPACE_DIR, SOUL_FILE))) ||\n"
     "      pathExists(join(dir, LEGACY_CHARACTER_FILE))",
     "      (workspaceRoot === undefined &&\n"
     "        pathExists(join(dir, CHARACTER_WORKSPACE_DIR, SOUL_FILE))) &&\n"
     "      pathExists(join(dir, LEGACY_CHARACTER_FILE))"),
    (DIRS, "discoverCharacters: drop the legacy character.md branch",
     "      pathExists(join(dir, LEGACY_CHARACTER_FILE))",
     "      false"),
    (DIRS, "discoverCharacters: the config tree is searched even when a workspace root is given",
     "      (workspaceRoot === undefined &&\n"
     "        pathExists(join(dir, CHARACTER_WORKSPACE_DIR, SOUL_FILE))) ||",
     "      pathExists(join(dir, CHARACTER_WORKSPACE_DIR, SOUL_FILE)) ||"),
    (DIRS, "discoverCharacters: the workspace root is never searched",
     "    for (const name of readdirOrEmpty(workspaceRoot)) {",
     "    for (const name of [] as string[]) {"),
    (DIRS, "loadCharacterDefinition: legacy wins over SOUL.md",
     "    readOrUndefined(characterWorkspaceFile(config, name, SOUL_FILE, workspaceRoot)) ??\n"
     "    readOrUndefined(rustJoin(characterConfigDir(config, name), LEGACY_CHARACTER_FILE))",
     "    readOrUndefined(rustJoin(characterConfigDir(config, name), LEGACY_CHARACTER_FILE)) ??\n"
     "    readOrUndefined(characterWorkspaceFile(config, name, SOUL_FILE, workspaceRoot))"),
    (DIRS, "loadCharacterDefinition: blank SOUL.md falls through to legacy",
     "  return (\n    readOrUndefined(characterWorkspaceFile(config, name, SOUL_FILE, workspaceRoot)) ??",
     "  return (\n    (readOrUndefined(characterWorkspaceFile(config, name, SOUL_FILE, workspaceRoot)) ||\n"
     "      undefined) ??"),
    (DIRS, "resolveUserDefinition: drop the legacy user.md fallback",
     'readOrUndefined(rustJoin(characterConfigDir(config, name), LEGACY_USER_FILE))', 'undefined'),
    (DIRS, "resolvePromptTemplate: global wins over the character override",
     'return (\n    readOrUndefined(\n      rustJoin(characterConfigDir(config, characterName), "prompts", templateName),\n    ) ?? readOrUndefined(rustJoin(config, "prompts", templateName))\n  );',
     'return (\n    readOrUndefined(rustJoin(config, "prompts", templateName)) ??\n    readOrUndefined(\n      rustJoin(characterConfigDir(config, characterName), "prompts", templateName),\n    )\n  );'),
    (DIRS, "resolvePromptTemplate: drop the global fallback",
     '?? readOrUndefined(rustJoin(config, "prompts", templateName))', '?? undefined'),
    # --- deep merge -------------------------------------------------------
    (LOAD, "deepMerge: overwrite tables instead of recursing",
     'if (isTable(baseVal) && isTable(overlayVal)) {', 'if (false) {'),
    (LOAD, "deepMerge: recurse when only the overlay is a table",
     'isTable(baseVal) && isTable(overlayVal)', 'isTable(overlayVal)'),
    (LOAD, "deepMerge: recurse when only the base is a table",
     'isTable(baseVal) && isTable(overlayVal)', 'isTable(baseVal)'),
    (LOAD, "deepMerge: treat arrays as tables",
     'return typeof value === "object" && value !== null && !Array.isArray(value);',
     'return typeof value === "object" && value !== null;'),
    (LOAD, "deepMerge: walk overlay keys in insertion order (EQUIVALENT — the overlay's "
     "keys are distinct, so the order they are copied in changes the merged table's "
     "insertion order and nothing else; reversing them fails no test in the suite)",
     "Object.keys(overlay).sort(compareByCodePoint)",
     "Object.keys(overlay)"),
    (LOAD, "deepMerge: skip keys absent from base",
     'const baseVal = base[key];', 'const baseVal = base[key];\n    if (!(key in base)) continue;'),
    # --- loader -----------------------------------------------------------
    (LOAD, "loader: keep `include` in the table",
     'delete table.include;', ''),
    (LOAD, "loader: a missing include is fatal",
     'if (!exists(includePath)) continue;', 'if (!exists(includePath)) throw new ConfigError("read_file", "missing", includePath);'),
    (LOAD, "loader: non-string include entries are used",
     'if (typeof item !== "string") continue;', ''),
    (LOAD, "loader: includes merge under the base instead of over it",
     'deepMerge(table, parseToml(readFileOrThrow(includePath), "parse_include", includePath));',
     'const inc = parseToml(readFileOrThrow(includePath), "parse_include", includePath);\n      deepMerge(inc, table);\n      Object.assign(table, inc);'),
    (LOAD, "loader: conf.d is never merged",
     '  loadConfD(rustJoin(configDirectory, "conf.d"), table, files);',
     "  void loadConfD;"),
    (LOAD, "loader: explicit config path does not re-home the config dir",
     'if (configPath !== undefined) dirs.config = configDirectory;', ''),
    (LOAD, "confd: unsorted merge order",
     '.sort(compareByCodePoint);', ';'),
    (LOAD, "confd: UTF-16 sort order",
     '.sort(compareByCodePoint);', '.sort();'),
    (LOAD, "confd: a missing directory is fatal",
     'if ((e as NodeJS.ErrnoException).code === "ENOENT") return;', ''),
    (LOAD, "confd: every read error is swallowed",
     'if ((e as NodeJS.ErrnoException).code === "ENOENT") return;', 'return;'),
    (LOAD, "extension: a bare .toml dotfile counts",
     'if (dot <= 0) return false;', 'if (dot < 0) return false;'),
    (LOAD, "extension: suffix match instead of exact extension",
     'return name.slice(dot + 1) === "toml";', 'return name.endsWith("toml");'),
    (LOAD, "extension: case-insensitive",
     'return name.slice(dot + 1) === "toml";', 'return name.slice(dot + 1).toLowerCase() === "toml";'),
    (LOAD, "parentOf: ignore trailing separators",
     'while (end > 1 && path[end - 1] === "/") end -= 1;', ''),
    (LOAD, "parentOf: root returns / instead of .",
     'if (trimmed === "/") return ".";', ''),
    (LOAD, "charConfig: overlay merged under the global table",
     "  const merged = structuredClone(global.table);\n  deepMerge(merged, overlay);",
     "  const merged = structuredClone(global.table);\n  deepMerge(overlay, merged);"),
    (LOAD, "charConfig: the loaded overlay is merged under the global table",
     "  const merged = structuredClone(global.rawTable ?? {});\n  deepMerge(merged, overlay);",
     "  const merged = structuredClone(global.rawTable ?? {});\n  deepMerge(overlay, merged);"),
    (LOAD, "charConfig: mutate the global table in place",
     'const merged = structuredClone(global.table);', 'const merged = global.table;'),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(
        MUTANTS,
        ["tests/dirs.test.ts", "tests/workspace_dir.test.ts", "tests/characters.test.ts"],
    )


if __name__ == "__main__":
    sys.exit(main())
