#!/usr/bin/env python3
"""Mutation pass over the character navigation commands (#18 / #12).

#12 requires every parity fixture be mutation-checked. This module's failure
modes are quiet ones — nothing here errors when it goes wrong:

- **A character vanishing from the listing.** `list_characters` is how a client
  learns what it may switch to. Drop the unconditional active-character prepend
  and a character with nothing on disk yet becomes unreachable through the UI,
  with no error anywhere.
- **A probe answering the wrong question.** `has_definition` asks whether
  `SOUL.md` is *there*; `definition_preview` asks whether it could be *read*.
  Collapsing the two — `is_file` for one, `exists` for the other — is invisible
  until someone's `SOUL.md` is a directory, and then the report is simply wrong.
- **Reading the wrong character's queue.** `character_info` takes a name; every
  path it builds has to be built from *that* name and not from the session's.
  Swapping one reports another character's pending edits as this one's.

A mutant is KILLED if `bun test tests/navigation.test.ts` fails with it
applied.

This stands at **37/38**, and the fixture needed no new cases to get there — it
already carried the cases that separate the pairs that matter: a directory named
`avatar.png` with a real `avatar.jpg` behind it, a `SOUL.md` that is a directory
(the only state where `has_definition` and `definition_preview` disagree), a
`character_info` call naming a character that is *not* the active one and has
its own deferred queue, a definition of 10 ASCII characters plus 600 emoji, and
`Zebra`/`Apple`/`apple` to separate a code-point sort from a case-insensitive
one.

The first pass read 34/40. Three of those six survivors were mis-written
patterns of mine, not gaps: one had the wrong indentation and never applied, one
uppercased a whole absolute path instead of just the extension, and one
"prepends the active character" mutant prepended the first *discovered* name,
which produces the identical list. Two more were equivalent mutants and have
been removed — see below. Fixing the three left one real survivor.

**The accepted survivor: `catch { continue }` in the avatar probe.**
Separating "an unreadable avatar falls through to the next extension" from "an
unreadable avatar ends the probe" needs a path that `is_file` accepts and a read
then rejects. On this filesystem only a permissions error does that, and
`workspace_index_parity` already documents why a chmod-based case cannot be
recorded here: the container the fixtures were generated in runs as root, where
mode 000 does not deny a read, so the generator would have recorded a successful
read and pinned nothing. The other trick that test uses — deleting the file
between the probe and the read — is not reachable either, because the probe and
the read are synchronous and adjacent. So the branch is real, defensive, and not
observable from outside; `characterMetadata` says so at the line itself.

For the same reason two mutants on the `is_file` probe were removed rather than
chased: replacing it with `exists`, and deleting it outright. Anything that is
not a readable file fails the read as well, so the probe and the catch are
mutually redundant and neither is separately observable. Both are kept, for the
reasons given in the source.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_navigation.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/navigation.ts"

# (label, find, replace)
MUTANTS = [
    # --- the avatar probe -----------------------------------------------------
    ("avatar: the probe order is reversed",
     '  ["avatar.png", "image/png"],\n'
     '  ["avatar.jpg", "image/jpeg"],\n'
     '  ["avatar.jpeg", "image/jpeg"],\n'
     '  ["avatar.webp", "image/webp"],',
     '  ["avatar.webp", "image/webp"],\n'
     '  ["avatar.jpeg", "image/jpeg"],\n'
     '  ["avatar.jpg", "image/jpeg"],\n'
     '  ["avatar.png", "image/png"],'),
    ("avatar: jpeg is served as image/jpg",
     '  ["avatar.jpeg", "image/jpeg"],',
     '  ["avatar.jpeg", "image/jpg"],'),
    ("avatar: a zero-byte file is embedded rather than skipped",
     "    if (data.length === 0) continue;",
     "    if (false) continue;"),
    ("avatar: a zero-byte file ends the probe instead of continuing it",
     "    if (data.length === 0) continue;",
     "    if (data.length === 0) return { name };"),
    ("avatar: an unreadable file ends the probe instead of continuing it",
     "    } catch {\n      continue;\n    }",
     "    } catch {\n      return { name };\n    }"),
    ("avatar: the bytes are sent raw rather than base64",
     '    return { name, avatar: { mime_type: mimeType, data: data.toString("base64") } };',
     '    return { name, avatar: { mime_type: mimeType, data: data.toString("latin1") } };'),
    ("avatar: probed in the workspace rather than the character directory",
     "    const path = rustJoin(characterConfigDir(configDir, name), file);",
     "    const path = rustJoin(characterWorkspaceDir(configDir, name), file);"),
    ("avatar: the extension match is case-insensitive",
     "    const path = rustJoin(characterConfigDir(configDir, name), file);",
     "    const dir = characterConfigDir(configDir, name);\n"
     "    const upper = rustJoin(dir, file.replace(/\\.\\w+$/, (e) => e.toUpperCase()));\n"
     "    const path = isFile(upper) ? upper : rustJoin(dir, file);"),
    ("avatar: no character ever has one",
     "  for (const [file, mimeType] of AVATARS) {",
     "  for (const [file, mimeType] of [] as typeof AVATARS) {"),

    # --- list_characters ------------------------------------------------------
    ("list: the active character is not prepended",
     "  const characters = active === undefined ? [] : [characterMetadata(configDir, active)];",
     "  const characters: CharacterInfo[] = [];"),
    ("list: the active character is prepended only when discoverable",
     "  const characters = active === undefined ? [] : [characterMetadata(configDir, active)];",
     "  const characters =\n"
     "    active === undefined || !discoverCharacters(configDir).includes(active)\n"
     "      ? []\n"
     "      : [characterMetadata(configDir, active)];"),
    ("list: the active character is appended rather than led with",
     "  const characters = active === undefined ? [] : [characterMetadata(configDir, active)];\n"
     "  for (const name of discoverCharacters(configDir, workspaceRoot)) {\n"
     "    if (name !== active) characters.push(characterMetadata(configDir, name));\n  }",
     "  const characters: CharacterInfo[] = [];\n"
     "  for (const name of discoverCharacters(configDir, workspaceRoot)) {\n"
     "    if (name !== active) characters.push(characterMetadata(configDir, name));\n  }\n"
     "  if (active !== undefined) characters.push(characterMetadata(configDir, active));"),
    ("list: the active character is not deduplicated out of discovery",
     "    if (name !== active) characters.push(characterMetadata(configDir, name));",
     "    characters.push(characterMetadata(configDir, name));"),
    ("list: discovery is dropped, only the active character is listed",
     "  for (const name of discoverCharacters(configDir, workspaceRoot)) {",
     "  for (const name of [] as string[]) {"),
    ("list: the listing is re-sorted, losing the active character's lead",
     "  return { characters };",
     "  return { characters: [...characters].sort((a, b) => (a.name < b.name ? -1 : 1)) };"),
    ("standalone: prepends the active character after all",
     "): CharacterListing => listCharacters(configDir, undefined, workspaceRoot);",
     '): CharacterListing => listCharacters(configDir, "ghost-active", workspaceRoot);'),
    ("standalone: the workspace root is dropped, so workspace-only characters vanish",
     "): CharacterListing => listCharacters(configDir, undefined, workspaceRoot);",
     "): CharacterListing => listCharacters(configDir, undefined, undefined);"),

    # --- character_info: which name -------------------------------------------
    ("info: an empty name argument is a name",
     '  const name = requested === undefined || requested === "" ? ctx.active : requested;',
     "  const name = requested === undefined ? ctx.active : requested;"),
    ("info: a non-string name argument is not coerced away",
     '  const requested = asStr(args["name"]);',
     '  const requested = args["name"] === undefined ? undefined : String(args["name"]);'),
    ("info: the requested name is ignored, always the active character",
     '  const name = requested === undefined || requested === "" ? ctx.active : requested;',
     "  const name = ctx.active;"),

    # --- character_info: the not-found gate -----------------------------------
    ("info: a missing directory is a miss even for the active character",
     "  if (!pathExists(charDir) && !pathExists(workspaceDir) && name !== ctx.active) {",
     "  if (!pathExists(charDir) && !pathExists(workspaceDir)) {"),
    ("info: a character with only a workspace is a miss",
     "  if (!pathExists(charDir) && !pathExists(workspaceDir) && name !== ctx.active) {",
     "  if (!pathExists(charDir) && name !== ctx.active) {"),
    ("info: nothing is ever a miss",
     "  if (!pathExists(charDir) && !pathExists(workspaceDir) && name !== ctx.active) {",
     "  if (false as boolean) {"),

    # --- character_info: the definition ---------------------------------------
    ("info: has_definition asks whether SOUL.md is readable, not present",
     "  const hasDefinition = pathExists(definitionPath);",
     "  const hasDefinition = isFile(definitionPath);"),
    ("info: an unreadable definition is previewed as empty rather than null",
     "  const definition = hasDefinition ? readOrUndefined(definitionPath) : undefined;",
     '  const definition = hasDefinition ? (readOrUndefined(definitionPath) ?? "") : undefined;'),
    ("info: the preview counts UTF-16 units rather than scalar values",
     "    definition_preview:\n"
     '      definition === undefined ? null : Array.from(definition).slice(0, PREVIEW_CHARS).join(""),',
     "    definition_preview:\n"
     "      definition === undefined ? null : definition.slice(0, PREVIEW_CHARS),"),
    ("info: the preview cap is off by one",
     "const PREVIEW_CHARS = 500;",
     "const PREVIEW_CHARS = 501;"),

    # --- character_info: the rest of the report -------------------------------
    ("info: bootstrap files are sorted rather than kept in declaration order",
     "    bootstrap_files: [SOUL_FILE, USER_FILE, AGENTS_FILE, TOOLS_FILE].filter((file) =>",
     "    bootstrap_files: [SOUL_FILE, USER_FILE, AGENTS_FILE, TOOLS_FILE].toSorted().filter((file) =>"),
    ("info: bootstrap files are not filtered by what is present",
     "    bootstrap_files: [SOUL_FILE, USER_FILE, AGENTS_FILE, TOOLS_FILE].filter((file) =>\n"
     "      pathExists(characterWorkspaceFile(ctx.configDir, name, file, ctx.workspaceRoot)),\n"
     "    ),",
     "    bootstrap_files: [SOUL_FILE, USER_FILE, AGENTS_FILE, TOOLS_FILE],"),
    ("info: the config override is looked for in the workspace",
     '    has_config_override: pathExists(rustJoin(charDir, "config.toml")),',
     '    has_config_override: pathExists(rustJoin(workspaceDir, "config.toml")),'),
    ("info: the deferred queue is read for the active character, not the named one",
     "  const dataDir = characterDataDir(ctx.dataDir, name);",
     "  const dataDir = characterDataDir(ctx.dataDir, ctx.active);"),
    ("info: an unreadable deferred queue propagates instead of reporting nothing",
     "  const pending = await pendingDeferredEditPaths(dataDir).catch(() => []);",
     "  const pending = await pendingDeferredEditPaths(dataDir);"),
    ("info: active is reported against the requested name rather than the session's",
     "    active: name === ctx.active,",
     "    active: true,"),

    # --- switch_character -----------------------------------------------------
    ("switch: a non-string name is used rather than treated as missing",
     '  const name = asStr(args["name"]);\n'
     '  if (name === undefined) throw invalidRequest("Missing required argument: name");',
     '  const name = args["name"] === undefined ? undefined : String(args["name"]);\n'
     '  if (name === undefined) throw invalidRequest("Missing required argument: name");'),
    ("switch: an empty name is a missing argument",
     "  if (name === undefined) throw invalidRequest(\"Missing required argument: name\");",
     '  if (name === undefined || name === "") throw invalidRequest("Missing required argument: name");'),
    ("switch: the same-name check runs after the discovery probe",
     "  if (name === active) return { character: name, changed: false };\n\n"
     "  if (!discoverCharacters(configDir, workspaceRoot).includes(name)) {\n"
     "    throw notFound(`Character not found: ${name}`);\n  }",
     "  if (!discoverCharacters(configDir, workspaceRoot).includes(name)) {\n"
     "    throw notFound(`Character not found: ${name}`);\n  }\n"
     "  if (name === active) return { character: name, changed: false };"),
    ("switch: an undiscoverable character is accepted",
     "  if (!discoverCharacters(configDir, workspaceRoot).includes(name)) {",
     "  if (false as boolean) {"),
    ("switch: existence is gated on the config directory rather than discovery",
     "  if (!discoverCharacters(configDir, workspaceRoot).includes(name)) {",
     "  if (!pathExists(characterConfigDir(configDir, name))) {"),
    ("switch: changed is always true",
     "  if (name === active) return { character: name, changed: false };",
     "  if (name === active) return { character: name, changed: true };"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/navigation.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
