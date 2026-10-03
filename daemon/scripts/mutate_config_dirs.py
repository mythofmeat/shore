#!/usr/bin/env python3
"""Mutation pass over config directory resolution and loading: path joins, XDG
lookups, character discovery, includes, conf.d, and per-character overlays.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIRS = ROOT / "src/config/dirs.ts"
LOAD = ROOT / "src/config/loader.ts"

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
     "  ).sort(compareByCodePoint);",
     "  ).sort();"),
    (DIRS, "discoverCharacters: do not sort at all",
     "  ).sort(compareByCodePoint);",
     "  );"),
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
    (LOAD, "loader: includes merge under the base instead of over it",
     'deepMerge(table, read(readFileOrThrow(includePath), "parse_include", includePath));',
     'const inc = read(readFileOrThrow(includePath), "parse_include", includePath);\n      deepMerge(inc, table);\n      Object.assign(table, inc);'),
    (LOAD, "loader: conf.d is never merged",
     '  loadConfD(rustJoin(configDirectory, "conf.d"), table, files, read);',
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


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(
        MUTANTS,
        ["tests/dirs.test.ts", "tests/workspace_dir.test.ts", "tests/characters.test.ts"],
    )


if __name__ == "__main__":
    sys.exit(main())
