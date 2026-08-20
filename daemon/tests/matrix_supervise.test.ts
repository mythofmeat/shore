import { describe, expect, test } from "bun:test";

import { defaultAppConfig, defaultMatrixConfig, type MatrixConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { ACCESS_TOKEN_ENV } from "../src/connections/matrix/start.ts";
import {
  retryDelay,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  superviseMatrixBridge,
  type SupervisorOptions,
} from "../src/connections/matrix/supervise.ts";
import { Server } from "../src/swp/server.ts";
import { testTmp } from "./support/tmp.ts";
import { mkdtempSync } from "node:fs";

const usable = (): MatrixConfig => ({
  ...defaultMatrixConfig(),
  enabled: true,
  homeserver: "https://matrix.example.com",
  user_id: "@shore:example.com",
});

const loaded = (matrix: MatrixConfig | undefined): LoadedConfig =>
  ({
    app: { ...defaultAppConfig(), connections: { matrix } },
    dirs: {
      config: mkdtempSync(testTmp("shore-sup-config-")),
      data: mkdtempSync(testTmp("shore-sup-data-")),
    },
  }) as LoadedConfig;

const unknownToken = () =>
  Object.assign(new Error("[401] Invalid token"), { errcode: "M_UNKNOWN_TOKEN" });

class FaultingBot {
  readonly userId = "@shore:example.com";
  #reportFault!: (fault: Error) => void;
  #wake: (() => void) | null = null;
  #stopped = false;
  readonly faulted = new Promise<Error>((resolve) => {
    this.#reportFault = resolve;
  });

  fault(error: Error): void {
    this.#reportFault(error);
    this.stop();
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): void {
    this.#stopped = true;
    this.#wake?.();
  }

  resolveRoom(alias: string): Promise<string | undefined> {
    return Promise.resolve(alias);
  }

  // eslint-disable-next-line require-yield
  async *events(): AsyncGenerator<never> {
    for (;;) {
      if (this.#stopped) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }

  sendText(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  sendNotice(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  editText(): Promise<boolean> {
    return Promise.resolve(true);
  }
  redact(): Promise<void> {
    return Promise.resolve();
  }
  setTyping(): Promise<void> {
    return Promise.resolve();
  }
  sendImage(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  downloadMedia(): Promise<Uint8Array | undefined> {
    return Promise.resolve(undefined);
  }
}

function supervisor(
  logins: readonly (() => Promise<never>)[],
  matrix: MatrixConfig | undefined = usable(),
): { options: SupervisorOptions; attempts: () => number; warnings: string[] } {
  const warnings: string[] = [];
  let attempts = 0;
  const options: SupervisorOptions = {
    config: loaded(matrix),
    server: new Server({ addr: "127.0.0.1:0", serverName: "t", authenticate: () => true }),
    env: { [ACCESS_TOKEN_ENV]: "t" },
    log: { warn: (message: string) => warnings.push(message) },
    login: ((): Promise<never> => {
      const next = logins[Math.min(attempts, logins.length - 1)];
      attempts += 1;
      return next!();
    }),
    retry: { baseMs: 1, capMs: 2, stableMs: 1_000, now: () => 0 },
  };
  return { options, attempts: () => attempts, warnings };
}

describe("the backoff curve", () => {
  test("it doubles from the base and stops at the cap", () => {
    expect(retryDelay(0)).toBe(RETRY_BASE_MS);
    expect(retryDelay(1)).toBe(60_000);
    expect(retryDelay(2)).toBe(120_000);
    expect(retryDelay(20)).toBe(RETRY_CAP_MS);
  });
});

describe("supervising the bridge", () => {
  test("an unreachable homeserver is retried, not given up on", async () => {
    const { options, attempts } = supervisor([() => Promise.reject(new Error("ECONNREFUSED"))]);
    const bridge = superviseMatrixBridge(options);
    await Bun.sleep(30);
    await bridge.stop();
    expect(attempts()).toBeGreaterThan(2);
  });

  test("a rejected token is not retried, because the token comes from the environment", async () => {
    const { options, attempts, warnings } = supervisor([() => Promise.reject(unknownToken())]);
    const bridge = superviseMatrixBridge(options);
    await bridge.done;
    expect(attempts()).toBe(1);
    expect(warnings.join("\n")).toContain("until the daemon restarts");
  });

  test("a section that is off is never retried, and never logs a retry", async () => {
    const { options, attempts, warnings } = supervisor(
      [() => Promise.reject(new Error("should not be reached"))],
      { ...usable(), enabled: false },
    );
    const bridge = superviseMatrixBridge(options);
    await bridge.done;
    expect(attempts()).toBe(0);
    expect(warnings.join("\n")).not.toContain("will retry");
  });

  test("a bridge whose sync dies mid-run is stood back up", async () => {
    const bots: FaultingBot[] = [];
    const options: SupervisorOptions = {
      config: loaded(usable()),
      server: new Server({ addr: "127.0.0.1:0", serverName: "t", authenticate: () => true }),
      env: { [ACCESS_TOKEN_ENV]: "t" },
      log: { warn: () => {} },
      login: (() => {
        const bot = new FaultingBot();
        bots.push(bot);
        return Promise.resolve(bot);
      }) as never,
      retry: { baseMs: 1, capMs: 2, stableMs: 1_000, now: () => 0 },
    };

    const bridge = superviseMatrixBridge(options);
    await Bun.sleep(20);
    expect(bots.length).toBe(1);

    bots[0]!.fault(new Error("the Matrix sync entered STOPPED"));
    await Bun.sleep(30);
    expect(bots.length).toBe(2);

    await bridge.stop();
  });

  test("a mid-run fault with a rejected token stops instead of looping", async () => {
    const bots: FaultingBot[] = [];
    const warnings: string[] = [];
    const bridge = superviseMatrixBridge({
      config: loaded(usable()),
      server: new Server({ addr: "127.0.0.1:0", serverName: "t", authenticate: () => true }),
      env: { [ACCESS_TOKEN_ENV]: "t" },
      log: { warn: (message: string) => warnings.push(message) },
      login: (() => {
        const bot = new FaultingBot();
        bots.push(bot);
        return Promise.resolve(bot);
      }) as never,
      retry: { baseMs: 1, capMs: 2, stableMs: 1_000, now: () => 0 },
    });

    await Bun.sleep(20);
    bots[0]!.fault(unknownToken());
    await bridge.done;
    expect(bots.length).toBe(1);
    expect(warnings.join("\n")).toContain("until the daemon restarts");
  });

  test("stopping cuts the backoff short rather than waiting it out", async () => {
    const { options } = supervisor([() => Promise.reject(new Error("ECONNREFUSED"))]);
    const bridge = superviseMatrixBridge({
      ...options,
      retry: { baseMs: 60_000, capMs: 60_000, stableMs: 1_000, now: () => 0 },
    });
    await Bun.sleep(10);
    const startedAt = performance.now();
    await bridge.stop();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
