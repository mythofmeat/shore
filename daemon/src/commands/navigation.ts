import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  SOUL_FILE,
  TOOLS_FILE,
  USER_FILE,
  characterConfigDir,
  characterDataDir,
  characterWorkspaceDir,
  characterWorkspaceFile,
  discoverCharacters,
  isFile,
  isUsableCharacterName,
  pathExists,
  readOrUndefined,
  rustJoin,
} from "../config/dirs.ts";
import { pendingDeferredEditPaths } from "../memory/deferred_edits.ts";
import type { CharacterCreated } from "../protocol/CharacterCreated.ts";
import type { CharacterDetails } from "../protocol/CharacterDetails.ts";
import type { CharacterListing } from "../protocol/CharacterListing.ts";
import type { CharacterSelection } from "../protocol/CharacterSelection.ts";
import type { CharacterInfo } from "../protocol/CharacterInfo.ts";
import type { CharacterWorkspace } from "../tools/character_workspace.ts";
import { invalidRequest, notFound } from "./errors.ts";

export type Args = Record<string, unknown>;

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function requireUsableCharacterName(name: string): void {
  if (isUsableCharacterName(name)) return;
  throw invalidRequest(`Not a usable character name: ${name}`);
}

const AVATARS: readonly (readonly [file: string, mimeType: string])[] = [
  ["avatar.png", "image/png"],
  ["avatar.jpg", "image/jpeg"],
  ["avatar.jpeg", "image/jpeg"],
  ["avatar.webp", "image/webp"],
];

export function characterMetadata(configDir: string, name: string): CharacterInfo {
  for (const [file, mimeType] of AVATARS) {
    const path = rustJoin(characterConfigDir(configDir, name), file);
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

export function listCharacters(
  configDir: string,
  active?: string,
  workspaceRoot?: string,
): CharacterListing {
  const characters = active === undefined ? [] : [characterMetadata(configDir, active)];
  for (const name of discoverCharacters(configDir, workspaceRoot)) {
    if (name !== active) characters.push(characterMetadata(configDir, name));
  }
  return { characters };
}

export const listCharactersStandalone = (
  configDir: string,
  workspaceRoot?: string,
): CharacterListing => listCharacters(configDir, undefined, workspaceRoot);

const PREVIEW_CHARS = 500;

export interface CharacterInfoContext {
  configDir: string;
  dataDir: string;
  active: string;
  workspaceRoot?: string | undefined;
}

export async function characterInfo(ctx: CharacterInfoContext, args: Args): Promise<CharacterDetails> {
  const requested = asStr(args["name"]);
  const name = requested === undefined || requested === "" ? ctx.active : requested;
  requireUsableCharacterName(name);

  const charDir = characterConfigDir(ctx.configDir, name);
  const workspaceDir = characterWorkspaceDir(ctx.configDir, name, ctx.workspaceRoot);
  if (!pathExists(charDir) && !pathExists(workspaceDir) && name !== ctx.active) {
    throw notFound(`Character not found: ${name}`);
  }

  const definitionPath = characterWorkspaceFile(
    ctx.configDir,
    name,
    SOUL_FILE,
    ctx.workspaceRoot,
  );
  const hasDefinition = pathExists(definitionPath);
  const definition = hasDefinition ? readOrUndefined(definitionPath) : undefined;

  const dataDir = characterDataDir(ctx.dataDir, name);
  const pending = await pendingDeferredEditPaths(dataDir).catch(() => []);

  return {
    name,
    active: name === ctx.active,
    config_dir: charDir,
    workspace_dir: workspaceDir,
    has_definition: hasDefinition,
    definition_preview:
      definition === undefined ? null : Array.from(definition).slice(0, PREVIEW_CHARS).join(""),
    bootstrap_files: [SOUL_FILE, USER_FILE, TOOLS_FILE].filter((file) =>
      pathExists(characterWorkspaceFile(ctx.configDir, name, file, ctx.workspaceRoot)),
    ),
    has_config_override: pathExists(rustJoin(charDir, "config.toml")),
    pending_deferred_edits: pending,
    data_dir: dataDir,
    has_data: pathExists(dataDir),
  };
}


const soulTemplate = (name: string): string => `You are ${name}.\n`;

const scaffoldedFiles = (
  name: string,
): readonly (readonly [file: string, content: string])[] => [
  [SOUL_FILE, soulTemplate(name)],
  [USER_FILE, ""],
  [TOOLS_FILE, ""],
];

function requestedCharacterName(args: Args): string {
  const name = asStr(args["name"]);
  if (name === undefined || name === "") {
    throw invalidRequest("Missing required argument: name");
  }
  requireUsableCharacterName(name);
  return name;
}

export function createCharacter(
  configDir: string,
  args: Args,
  workspaceRoot?: string,
): CharacterCreated {
  const name = requestedCharacterName(args);

  const workspaceDir = characterWorkspaceDir(configDir, name, workspaceRoot);
  if (pathExists(rustJoin(workspaceDir, SOUL_FILE))) {
    throw invalidRequest(`Character '${name}' already exists at ${workspaceDir}`);
  }

  mkdirSync(workspaceDir, { recursive: true });
  const created: string[] = [];
  for (const [file, content] of scaffoldedFiles(name)) {
    const path = rustJoin(workspaceDir, file);
    if (pathExists(path)) continue;
    writeFileSync(path, content);
    created.push(file);
  }

  return {
    character: name,
    workspace_dir: workspaceDir,
    config_dir: characterConfigDir(configDir, name),
    created_files: created,
  };
}

export async function createCharacterAs(
  configDir: string,
  args: Args,
  workspaceRoot: string | undefined,
  workspaceFor: (name: string) => CharacterWorkspace,
): Promise<CharacterCreated> {
  const name = requestedCharacterName(args);
  const workspace = workspaceFor(name);
  if (!workspace.isolated) return createCharacter(configDir, args, workspaceRoot);
  const [soul = false] = await workspace.call("exists", { paths: [rustJoin(workspace.dir, SOUL_FILE)] });
  if (soul) throw invalidRequest(`Character '${name}' already exists at ${workspace.dir}`);
  try {
    await workspace.call("mkdir", { path: workspace.dir });
  } catch (error) {
    throw invalidRequest(
      `${name}'s tools run as ${workspace.tools.user ?? "another user"}, who cannot create ${workspace.dir} ` +
        `(${error instanceof Error ? error.message : String(error)}): create that folder owned by them first`,
    );
  }
  const created: string[] = [];
  for (const [file, content] of scaffoldedFiles(name)) {
    const data = Buffer.from(content, "utf8").toString("base64");
    if (await workspace.call("createFile", { path: rustJoin(workspace.dir, file), data })) created.push(file);
  }
  return {
    character: name,
    workspace_dir: workspace.dir,
    config_dir: characterConfigDir(configDir, name),
    created_files: created,
  };
}

export type CharacterSwitch = CharacterSelection;

export function switchCharacter(
  configDir: string,
  active: string | undefined,
  args: Args,
  workspaceRoot?: string,
): CharacterSwitch {
  const name = asStr(args["name"]);
  if (name === undefined) throw invalidRequest("Missing required argument: name");
  requireUsableCharacterName(name);

  if (name === active) return { character: name, changed: false };

  if (!discoverCharacters(configDir, workspaceRoot).includes(name)) {
    throw notFound(`Character not found: ${name}`);
  }
  return { character: name, changed: true };
}
