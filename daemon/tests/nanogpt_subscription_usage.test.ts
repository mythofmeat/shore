import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { reportedNanoGptSubscription } from "../src/commands/providers.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps } from "../src/handler/deps.ts";
import {
  nanoGptSubscriptionPath,
  writeNanoGptSubscription,
  type NanoGptSubscriptionState,
} from "../src/llm/nanogpt_subscription.ts";
import { configureSecretStore, SecretStore, secretStorePath } from "../src/llm/secret_store.ts";
import { createRuntime } from "../src/runtime.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { restoreTestEnv, setTestEnv, unsetTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

const KEY_ENV = "SHORE_USAGE_NANOGPT_KEY";

afterAll(() => {
  restoreTestEnv();
  configureSecretStore(undefined);
});

function subscription(state: NanoGptSubscriptionState["state"], fetchedAt = new Date()): NanoGptSubscriptionState {
  return {
    version: 1,
    fetched_at: fetchedAt.toISOString(),
    active: state === "active",
    state,
    weeklyInputTokens: { used: 0, remaining: 60_000_000, limit: 60_000_000, resetAt: "2026-11-09T00:00:00+00:00" },
  };
}

async function configWith(providers: Record<string, unknown> | undefined): Promise<LoadedConfig> {
  const root = await mkdtemp(testTmp("shore-usage-nanogpt-"));
  return {
    app: defaultAppConfig(),
    models: emptyCatalog(),
    providers: ProviderRegistry.fromSection(providers),
    rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
}

async function cached(config: LoadedConfig, state: NanoGptSubscriptionState): Promise<void> {
  await writeNanoGptSubscription(nanoGptSubscriptionPath(config.dirs.cache), state);
}

const KEYED = { nanogpt: { api_key_env: KEY_ENV } };

test("a subscription with a usable key is reported while it is active or in grace", async () => {
  setTestEnv(KEY_ENV, "fixture-key");
  for (const state of ["active", "grace"] as const) {
    const config = await configWith(KEYED);
    await cached(config, subscription(state));
    expect(reportedNanoGptSubscription(config)?.state).toBe(state);
  }
});

test("an inactive state is not a subscription, whatever the key says", async () => {
  setTestEnv(KEY_ENV, "fixture-key");
  const config = await configWith(KEYED);
  await cached(config, subscription("inactive"));
  expect(reportedNanoGptSubscription(config)).toBeUndefined();
});

test("a cached subscription is not reported once its key is gone", async () => {
  unsetTestEnv(KEY_ENV);
  const config = await configWith(KEYED);
  await cached(config, subscription("active"));
  expect(reportedNanoGptSubscription(config)).toBeUndefined();

  setTestEnv(KEY_ENV, "   ");
  expect(reportedNanoGptSubscription(config)).toBeUndefined();
});

test("a cached subscription is not reported while the provider is disabled", async () => {
  setTestEnv(KEY_ENV, "fixture-key");
  const config = await configWith({ nanogpt: { api_key_env: KEY_ENV, enabled: false } });
  await cached(config, subscription("active"));
  expect(reportedNanoGptSubscription(config)).toBeUndefined();
});

test("the default key counts for an install with no nanogpt provider section", async () => {
  const config = await configWith(undefined);
  await cached(config, subscription("active"));

  unsetTestEnv("NANOGPT_API_KEY");
  expect(reportedNanoGptSubscription(config)).toBeUndefined();

  setTestEnv("NANOGPT_API_KEY", "fixture-key");
  expect(reportedNanoGptSubscription(config)?.state).toBe("active");
});

test("a key saved on the daemon counts as usable", async () => {
  const config = await configWith({ nanogpt: { keys: [{ name: "saved" }] } });
  await cached(config, subscription("active"));
  configureSecretStore(config.dirs.data);
  expect(reportedNanoGptSubscription(config)).toBeUndefined();

  new SecretStore(secretStorePath(config.dirs.data)).set("nanogpt", "saved", "fixture-key");
  expect(reportedNanoGptSubscription(config)?.state).toBe("active");
});

test("a subscriber between calls keeps the section after the five-minute refresh window", async () => {
  setTestEnv(KEY_ENV, "fixture-key");
  const config = await configWith(KEYED);
  await cached(config, subscription("active", new Date(Date.now() - 3 * 86_400_000)));
  expect(reportedNanoGptSubscription(config)?.state).toBe("active");
});

test("the usage command sends the subscription only for an install that has one", async () => {
  const config = await configWith(KEYED);
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  await cached(config, subscription("active"));
  const runtime = await createRuntime({ config, providers: {}, env: {} });
  const commands = buildCommandPathDeps({
    runtime, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(),
    router: new SessionRouter(), handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env: {},
  });
  const sent = async (): Promise<unknown> => {
    const reply = await dispatchCommand(commands, { name: "usage", args: {} }, {
      session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: null },
      rid: "usage",
      kind: "command",
    });
    if (reply.type !== "command_output") throw new Error(`usage answered ${reply.type}`);
    return (reply.data as { nanogpt_subscription: unknown }).nanogpt_subscription;
  };
  try {
    setTestEnv(KEY_ENV, "fixture-key");
    expect(await sent()).toMatchObject({ state: "active" });

    unsetTestEnv(KEY_ENV);
    expect(await sent()).toBeNull();

    setTestEnv(KEY_ENV, "fixture-key");
    await cached(config, subscription("inactive"));
    expect(await sent()).toBeNull();
  } finally {
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
  }
});
