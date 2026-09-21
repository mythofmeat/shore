import { openStorage } from "../../storage/store.ts";

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
  readonly faulted: Promise<Error>;
  stop(): Promise<void>;
}

export type StartOutcome =
  | { readonly kind: "started"; readonly handle: BridgeHandle }
  | { readonly kind: "off"; readonly reason: string | undefined }
  | { readonly kind: "failed"; readonly error: unknown };

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

export async function attemptMatrixBridge(options: StartOptions): Promise<StartOutcome> {
  const matrix = options.config.app.connections.matrix;
  if (matrix === undefined || !matrix.enabled) return { kind: "off", reason: undefined };

  const credentials = readCredentials(options.env);
  const unusable = unusableReason(matrix, credentials);
  if (unusable !== undefined) {
    options.log?.warn?.(`Matrix bridge not started: ${unusable}`);
    return { kind: "off", reason: unusable };
  }

  const stateDir = rustJoin(options.config.dirs.data, STATE_DIR);
  try { openStorage(options.config.dirs.data).close(); }
  catch (e) {
    const reason = `cannot create database state: ${String(e)}`;
    options.log?.warn?.(`Matrix bridge not started: ${reason}`);
    return { kind: "off", reason };
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
    return { kind: "failed", error: e };
  }

  const initialRoomId =
    matrix.room_id.trim() === "" ? undefined : await bot.resolveRoom(matrix.room_id);

  const bridge = new Bridge({
    bot,
    attach: (character) =>
      options.server.attachLocal({
        clientType: "bridge",
        clientName: `shore-matrix/${character}`,
        capabilities: ["streaming", "history-deltas", "multimodal-tool-results"],
        character,
        onLag: (skipped) =>
          options.log?.warn?.("Matrix bridge fell behind", { skipped, character }),
      }),
    roster: async () => (await options.server.characters()).map((c) => c.name),
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
    kind: "started",
    handle: {
      done,
      faulted: bot.faulted,
      stop: async () => {
        bot.stop();
        await done;
      },
    },
  };
}

function nonBlank(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
