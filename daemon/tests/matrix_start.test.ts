import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { defaultAppConfig, defaultMatrixConfig, type MatrixConfig } from "../src/config/app.ts";
import { restartRequiredChanges } from "../src/config/restart.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { isTerminalMatrixError } from "../src/connections/matrix/bot.ts";
import {
  ACCESS_TOKEN_ENV,
  DEVICE_ID_ENV,
  PASSWORD_ENV,
  readCredentials,
  attemptMatrixBridge,
  unusableReason,
} from "../src/connections/matrix/start.ts";
import { Server } from "../src/swp/server.ts";
import { testTmp } from "./support/tmp.ts";

const usable = (): MatrixConfig => ({
  ...defaultMatrixConfig(),
  enabled: true,
  homeserver: "https://matrix.example.com",
  user_id: "@shore:example.com",
});

const withToken = { accessToken: "t", password: undefined, deviceId: undefined };

describe("credentials", () => {
  test("they come from the environment, never from config.toml", () => {
    expect(readCredentials({ [ACCESS_TOKEN_ENV]: "secret" })).toEqual({
      accessToken: "secret",
      password: undefined,
      deviceId: undefined,
    });
    expect(readCredentials({ [PASSWORD_ENV]: "hunter2", [DEVICE_ID_ENV]: "DEV1" })).toEqual({
      accessToken: undefined,
      password: "hunter2",
      deviceId: "DEV1",
    });
  });

  test("blank is unset, which is what an empty compose variable expands to", () => {
    expect(readCredentials({ [ACCESS_TOKEN_ENV]: "   " }).accessToken).toBeUndefined();
  });
});

describe("what makes the section unusable", () => {
  test("a complete section with a credential is usable", () => {
    expect(unusableReason(usable(), withToken)).toBeUndefined();
    expect(
      unusableReason(usable(), { accessToken: undefined, password: "p", deviceId: undefined }),
    ).toBeUndefined();
  });

  test("missing fields are named, together", () => {
    expect(unusableReason({ ...defaultMatrixConfig(), enabled: true }, withToken)).toContain(
      "homeserver and user_id",
    );
    expect(
      unusableReason({ ...usable(), user_id: "  " }, withToken),
    ).toContain("missing user_id");
  });

  test("no credential names both variables", () => {
    const reason = unusableReason(usable(), {
      accessToken: undefined,
      password: undefined,
      deviceId: undefined,
    });
    expect(reason).toContain(ACCESS_TOKEN_ENV);
    expect(reason).toContain(PASSWORD_ENV);
  });
});

describe("starting", () => {
  const loaded = (
    matrix: MatrixConfig | undefined,
    dataDir = mkdtempSync(testTmp("shore-matrix-start-")),
    configDir = mkdtempSync(testTmp("shore-matrix-config-")),
  ): LoadedConfig =>
    ({
      app: { ...defaultAppConfig(), connections: { telegram: undefined, discord: undefined, matrix } },
      dirs: { config: configDir, data: dataDir },
    }) as LoadedConfig;

  const server = () =>
    new Server({ addr: "127.0.0.1:0", serverName: "t", authenticate: () => true });

  test("no section means no bridge, and no Matrix login is attempted", async () => {
    let attempted = false;
    const outcome = await attemptMatrixBridge({
      config: loaded(undefined),
      server: server(),
      env: {},
      login: (() => {
        attempted = true;
        throw new Error("should not be reached");
      }) as never,
    });
    expect(outcome.kind).toBe("off");
    expect(attempted).toBe(false);
  });

  test("enabled = false means no bridge", async () => {
    const outcome = await attemptMatrixBridge({
      config: loaded({ ...usable(), enabled: false }),
      server: server(),
      env: { [ACCESS_TOKEN_ENV]: "t" },
      login: (() => {
        throw new Error("should not be reached");
      }) as never,
    });
    expect(outcome.kind).toBe("off");
  });

  test("an unwritable state directory warns rather than killing the daemon", async () => {
    const warnings: string[] = [];
    const outcome = await attemptMatrixBridge({
      config: loaded(usable(), "/nonexistent-shore-data"),
      server: server(),
      env: { [ACCESS_TOKEN_ENV]: "t" },
      log: { warn: (message: string) => warnings.push(message) },
      login: (() => {
        throw new Error("should not be reached");
      }) as never,
    });
    expect(outcome.kind).toBe("off");
    expect(warnings.join("\n")).toContain("cannot create");
  });

  test("enabled but unusable warns and leaves the daemon running", async () => {
    const warnings: string[] = [];
    const outcome = await attemptMatrixBridge({
      config: loaded({ ...usable(), enabled: true }),
      server: server(),
      env: {},
      log: { warn: (message: string) => warnings.push(message) },
      login: (() => {
        throw new Error("should not be reached");
      }) as never,
    });
    expect(outcome.kind).toBe("off");
    expect(warnings.join("\n")).toContain("not started");
    expect(warnings.join("\n")).toContain(ACCESS_TOKEN_ENV);
  });

  test("bridge state is daemon-written, so it lives under the data dir, not the config dir", async () => {
    const config = loaded({ ...usable(), enabled: true });
    await attemptMatrixBridge({
      config,
      server: server(),
      env: { [ACCESS_TOKEN_ENV]: "t" },
      log: { warn: () => {} },
      login: (() => Promise.reject(new Error("homeserver unreachable"))) as never,
    });
    expect(existsSync(join(config.dirs.data, "matrix"))).toBe(true);
    expect(existsSync(join(config.dirs.config, "matrix"))).toBe(false);
  });

  test("a Matrix login failure warns and leaves the daemon running", async () => {
    const warnings: string[] = [];
    const outcome = await attemptMatrixBridge({
      config: loaded({ ...usable(), enabled: true }),
      server: server(),
      env: { [ACCESS_TOKEN_ENV]: "t" },
      log: { warn: (message: string) => warnings.push(message) },
      login: (() => Promise.reject(new Error("homeserver unreachable"))) as never,
    });
    expect(outcome.kind).toBe("failed");
    expect(warnings.join("\n")).toContain("homeserver unreachable");
  });

  test("an unreachable homeserver is failed, not off, because only failed is worth retrying", async () => {
    const attempt = (error: Error) =>
      attemptMatrixBridge({
        config: loaded({ ...usable(), enabled: true }),
        server: server(),
        env: { [ACCESS_TOKEN_ENV]: "t" },
        log: { warn: () => {} },
        login: (() => Promise.reject(error)) as never,
      });

    expect((await attempt(new Error("ECONNREFUSED"))).kind).toBe("failed");
    const rejected = await attempt(
      Object.assign(new Error("[401] Invalid token"), { errcode: "M_UNKNOWN_TOKEN" }),
    );
    expect(rejected.kind).toBe("failed");
    expect(isTerminalMatrixError((rejected as { error: unknown }).error)).toBe(true);
  });
});

describe("reloading the section", () => {
  const configWith = (matrix: MatrixConfig | undefined): LoadedConfig =>
    ({
      app: { ...defaultAppConfig(), connections: { telegram: undefined, discord: undefined, matrix } },
    }) as LoadedConfig;

  test("a changed [connections] needs a restart, because the daemon owns the bridge", () => {
    expect(restartRequiredChanges(configWith(undefined), configWith(usable()))).toContain(
      "[connections]",
    );
    expect(
      restartRequiredChanges(configWith(usable()), configWith({ ...usable(), mirror_all: false })),
    ).toContain("[connections]");
  });

  test("an unchanged one does not", () => {
    expect(restartRequiredChanges(configWith(usable()), configWith(usable()))).not.toContain(
      "[connections]",
    );
  });
});
