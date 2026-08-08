import { mkdirSync } from "node:fs";

import type { MatrixConfig } from "../../config/app.ts";
import { rustJoin } from "../../config/dirs.ts";
import type { LoadedConfig } from "../../config/loader.ts";
import type { Server } from "../../swp/server.ts";
import { MatrixBot } from "./bot.ts";
import { Bridge, type BridgeLogger } from "./bridge.ts";
import { EventMap } from "./event_map.ts";
import { ViewPrefs } from "./prefs.ts";
import { RoomBindings } from "./rooms.ts";

export const ACCESS_TOKEN_ENV = "SHORE_MATRIX_ACCESS_TOKEN";

export const PASSWORD_ENV = "SHORE_MATRIX_PASSWORD";

export const DEVICE_ID_ENV = "SHORE_MATRIX_DEVICE_ID";

const STATE_DIR = "matrix";

export interface MatrixCredentials {
  readonly accessToken: string | undefined;
  readonly password: string | undefined;
  readonly deviceId: string | undefined;
}

export interface BridgeHandle {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export function readCredentials(env: NodeJS.ProcessEnv): MatrixCredentials {
  return {
    accessToken: nonBlank(env[ACCESS_TOKEN_ENV]),
    password: nonBlank(env[PASSWORD_ENV]),
    deviceId: nonBlank(env[DEVICE_ID_ENV]),
  };
}

export function unusableReason(
  matrix: MatrixConfig,
  credentials: MatrixCredentials,
): string | undefined {
  const missing: string[] = [];
  if (matrix.homeserver.trim() === "") missing.push("homeserver");
  if (matrix.user_id.trim() === "") missing.push("user_id");
  if (missing.length > 0) {
    return `[connections.matrix] is missing ${missing.join(" and ")}`;
  }
  if (credentials.accessToken === undefined && credentials.password === undefined) {
    return `no Matrix credential: set $${ACCESS_TOKEN_ENV} or $${PASSWORD_ENV}`;
  }
  return undefined;
}

export interface StartOptions {
  readonly config: LoadedConfig;
  readonly server: Server;
  readonly env: NodeJS.ProcessEnv;
  readonly log?: BridgeLogger | undefined;
  readonly login?: typeof MatrixBot.login;
}

export async function startMatrixBridge(options: StartOptions): Promise<BridgeHandle | undefined> {
  const matrix = options.config.app.connections.matrix;
  if (matrix === undefined || !matrix.enabled) return undefined;

  const credentials = readCredentials(options.env);
  const unusable = unusableReason(matrix, credentials);
  if (unusable !== undefined) {
    options.log?.warn?.(`Matrix bridge not started: ${unusable}`);
    return undefined;
  }

  const stateDir = rustJoin(options.config.dirs.config, STATE_DIR);
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (e) {
    options.log?.warn?.(`Matrix bridge not started: cannot create ${stateDir}: ${String(e)}`);
    return undefined;
  }

  const login = options.login ?? MatrixBot.login;
  let bot: MatrixBot;
  try {
    bot = await login({
      homeserver: matrix.homeserver,
      userId: matrix.user_id,
      ...(credentials.accessToken === undefined ? {} : { accessToken: credentials.accessToken }),
      ...(credentials.password === undefined ? {} : { password: credentials.password }),
      ...(credentials.deviceId === undefined ? {} : { deviceId: credentials.deviceId }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    await bot.start();
  } catch (e) {
    options.log?.warn?.(`Matrix bridge not started: ${String(e)}`);
    return undefined;
  }

  const initialRoomId =
    matrix.room_id.trim() === "" ? undefined : await bot.resolveRoom(matrix.room_id);

  const peer = await options.server.attachLocal({
    clientType: "bridge",
    clientName: "shore-matrix",
    capabilities: ["streaming"],
    onLag: (skipped) => options.log?.warn?.("Matrix bridge fell behind", { skipped }),
  });

  const bridge = new Bridge({
    bot,
    peer,
    rooms: new RoomBindings(rustJoin(stateDir, "rooms.json")),
    events: new EventMap(rustJoin(stateDir, "events.json")),
    prefs: new ViewPrefs(rustJoin(stateDir, "prefs.json")),
    mirrorAll: matrix.mirror_all,
    ...(initialRoomId === undefined ? {} : { initialRoomId }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  options.log?.info?.("Matrix bridge started", {
    homeserver: matrix.homeserver,
    user_id: matrix.user_id,
    mirror_all: matrix.mirror_all,
  });

  const done = bridge.run();
  return {
    done,
    stop: async () => {
      bot.stop();
      await peer.detach();
      await done;
    },
  };
}

function nonBlank(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
