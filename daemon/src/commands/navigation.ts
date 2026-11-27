import { mkdirSync, readFileSync } from "node:fs";

import {
  characterConfigDir,
  characterDataDir,
  discoverCharacters,
  isFile,
  isUsableCharacterName,
  pathExists,
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
): CharacterListing {
  const characters = active === undefined ? [] : [characterMetadata(configDir, active)];
  for (const name of discoverCharacters(configDir)) {
    if (name !== active) characters.push(characterMetadata(configDir, name));
  }
  return { characters };
}

export interface CharacterInfoContext {
  configDir: string;
  dataDir: string;
  active: string;
  workspaceFor: (name: string) => CharacterWorkspace;
}

export async function characterInfo(ctx: CharacterInfoContext, args: Args): Promise<CharacterDetails> {
  const requested = asStr(args["name"]);
  const name = requested === undefined || requested === "" ? ctx.active : requested;
  requireUsableCharacterName(name);

  const charDir = characterConfigDir(ctx.configDir, name);
  if (!pathExists(charDir) && name !== ctx.active) {
    throw notFound(`Character not found: ${name}`);
  }
  const workspace = ctx.workspaceFor(name);

  const dataDir = characterDataDir(ctx.dataDir, name);
  const pending = await pendingDeferredEditPaths(dataDir).catch(() => []);

  return {
    name,
    active: name === ctx.active,
    config_dir: charDir,
    workspace_dir: workspace.dir,
    prompt_files: workspace.promptFiles.filter((file) => pathExists(rustJoin(workspace.dir, file))),
    has_config_override: pathExists(rustJoin(charDir, "config.toml")),
    pending_deferred_edits: pending,
    data_dir: dataDir,
    has_data: pathExists(dataDir),
  };
}

function requestedCharacterName(args: Args): string {
  const name = asStr(args["name"]);
  if (name === undefined || name === "") {
    throw invalidRequest("Missing required argument: name");
  }
  requireUsableCharacterName(name);
  return name;
}

export async function createCharacter(
  configDir: string,
  args: Args,
  workspaceFor: (name: string) => CharacterWorkspace,
): Promise<CharacterCreated> {
  const name = requestedCharacterName(args);
  const charDir = characterConfigDir(configDir, name);
  if (pathExists(charDir)) throw invalidRequest(`Character '${name}' already exists at ${charDir}`);
  const workspace = workspaceFor(name);
  try {
    await workspace.call("mkdir", { path: workspace.dir });
  } catch (error) {
    throw invalidRequest(
      `${name}'s tools run as ${workspace.tools.user ?? "another user"}, who cannot create ${workspace.dir} ` +
        `(${error instanceof Error ? error.message : String(error)}): create that folder owned by them first`,
    );
  }
  mkdirSync(charDir, { recursive: true });
  return { character: name, workspace_dir: workspace.dir, config_dir: charDir };
}

export type CharacterSwitch = CharacterSelection;

export function switchCharacter(
  configDir: string,
  active: string | undefined,
  args: Args,
  threadsOf: (name: string) => readonly { id: string }[] = () => [],
): CharacterSwitch {
  const name = asStr(args["name"]);
  if (name === undefined) throw invalidRequest("Missing required argument: name");
  requireUsableCharacterName(name);
  if (name !== active && !discoverCharacters(configDir).includes(name)) {
    throw notFound(`Character not found: ${name}`);
  }
  const thread = asStr(args["thread"]);
  if (thread !== undefined && !threadsOf(name).some((each) => each.id === thread)) {
    throw notFound(`Thread not found: ${thread}`);
  }
  return { character: name, changed: name !== active };
}
