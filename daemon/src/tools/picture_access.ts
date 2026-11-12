import { chmodSync, chownSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { characterCacheDir } from "../config/dirs.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { shoreLog } from "../log.ts";
import { imageCacheDir } from "../storage/image_cache.ts";
import { characterUser } from "./character_user.ts";
import { characterToolsFor, characterWorkspace } from "./character_workspace.ts";

const DAEMON_ONLY = 0o700;
const OWN_GROUP_MAY_ENTER = 0o710;
const GROUP_MAY_ENTER = 0o010;

export function openPictureFolder(cache: string, character: string, gid: number): string {
  const folder = characterCacheDir(cache, character);
  const pictures = imageCacheDir(cache, character);
  mkdirSync(pictures, { recursive: true });
  chmodSync(folder, DAEMON_ONLY);
  chownSync(folder, statSync(folder).uid, gid);
  chmodSync(folder, OWN_GROUP_MAY_ENTER);
  for (const above of [dirname(folder), cache]) chmodSync(above, statSync(above).mode | GROUP_MAY_ENTER);
  return pictures;
}

export function closePictureFolder(cache: string, character: string): void {
  const folder = characterCacheDir(cache, character);
  if (statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true) chmodSync(folder, DAEMON_ONLY);
}

export async function sharePictureFolders(config: LoadedConfig, characters: readonly string[]): Promise<void> {
  const cache = config.dirs.cache;
  for (const character of characters) {
    const spec = characterToolsFor(config, character).user;
    if (spec === undefined) {
      closePictureFolder(cache, character);
      continue;
    }
    try {
      const user = await characterUser(spec);
      const pictures = openPictureFolder(cache, character, user.gid);
      const [reached] = await characterWorkspace(config, character).call("exists", { paths: [pictures] });
      if (reached !== true) {
        shoreLog.warn(
          `shore: ${character}'s tools run as ${spec}, and that user cannot reach ${pictures}, so the picture paths ${character} is given will not open. ` +
            `It has to be in the daemon's group (gid ${String(process.getgid?.())}) and able to pass every folder above ${cache}.`,
        );
      }
    } catch (error) {
      closePictureFolder(cache, character);
      const hint = (error as NodeJS.ErrnoException).code === "EPERM" ? " The daemon's user has to be in that user's group." : "";
      shoreLog.warn(`shore: could not open ${character}'s pictures to ${spec}, so the picture paths ${character} is given will not open: ${String(error)}.${hint}`);
    }
  }
}
