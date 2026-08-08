import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { defaultAppConfig, defaultMatrixConfig, type MatrixConfig } from "../src/config/app.ts";
import { restartRequiredChanges } from "../src/config/restart.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import {
  ACCESS_TOKEN_ENV,
  DEVICE_ID_ENV,
  PASSWORD_ENV,
  readCredentials,
  startMatrixBridge,
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
    configDir = mkdtempSync(testTmp("shore-matrix-start-")),
  ): LoadedConfig =>
    ({
      app: { ...defaultAppConfig(), connections: { telegram: undefined, discord: undefined, matrix } },
      dirs: { config: configDir, data: configDir },
    }) as LoadedConfig;

  const server = () =>
    new Server({ addr: "127.0.0.1:0", serverName: "t", authenticate: () => true });

  test("no section means no bridge, and no Matrix login is attempted", async () => {
    let attempted = false;
    const handle = await startMatrixBridge({
      config: loaded(undefined),
      server: server(),
      env: {},
      login: (() => {
        attempted = true;
        throw new Error("should not be reached");
      }) as never,
    });
    expect(handle).toBeUndefined();
    expect(attempted).toBe(false);
  });

  test("enabled = false means no bridge", async () => {
    const handle = await startMatrixBridge({
      config: loaded({ ...usable(), enabled: false }),
      server: server(),
      env: { [ACCESS_TOKEN_ENV]: "t" },
      login: (() => {
        throw new Error("should not be reached");
      }) as never,
    });
    expect(handle).toBeUndefined();
  });

  test("an unwritable state directory warns rather than killing the daemon", async () => {
    const warnings: string[] = [];
    const handle = await startMatrixBridge({
      config: loaded(usable(), "/nonexistent-shore-config"),
      server: server(),
      env: { [ACCESS_TOKEN_ENV]: "t" },
      log: { warn: (message) => warnings.push(message) },
      login: (() => {
        throw new Error("should not be reached");
      }) as never,
    });
    expect(handle).toBeUndefined();
    expect(warnings.join("\n")).toContain("cannot create");
  });

  test("enabled but unusable warns and leaves the daemon running", async () => {
    const warnings: string[] = [];
    const handle = await startMatrixBridge({
      config: loaded({ ...usable(), enabled: true }),
      server: server(),
      env: {},
      log: { warn: (message) => warnings.push(message) },
      login: (() => {
        throw new Error("should not be reached");
      }) as never,
    });
    expect(handle).toBeUndefined();
    expect(warnings.join("\n")).toContain("not started");
    expect(warnings.join("\n")).toContain(ACCESS_TOKEN_ENV);
  });

  test("a Matrix login failure warns and leaves the daemon running", async () => {
    const warnings: string[] = [];
    const handle = await startMatrixBridge({
      config: loaded({ ...usable(), enabled: true }),
      server: server(),
      env: { [ACCESS_TOKEN_ENV]: "t" },
      log: { warn: (message) => warnings.push(message) },
      login: (() => Promise.reject(new Error("homeserver unreachable"))) as never,
    });
    expect(handle).toBeUndefined();
    expect(warnings.join("\n")).toContain("homeserver unreachable");
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
