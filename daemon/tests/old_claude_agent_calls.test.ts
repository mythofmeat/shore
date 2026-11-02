import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { costSourceTotals } from "../src/ledger/query.ts";
import { closeLedgers, ledgerFor } from "../src/ledger/record.ts";
import { setSubscriptionProviders } from "../src/ledger/store.ts";
import { backfillLedgerCosts } from "../src/ledger/usage.ts";
import { createRuntime } from "../src/runtime.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";

interface Call {
  character?: string;
  provider: string;
  cost_source?: string;
  total_cost?: number;
}

afterEach(() => {
  setSubscriptionProviders(["opencode-go", "opencode"]);
  closeLedgers();
});

const OLD_SUBSCRIPTION_CALL: Call = { provider: "claude_agent" };

async function installWith(calls: readonly Call[], providers?: Record<string, unknown>): Promise<LoadedConfig> {
  const root = await mkdtemp(testTmp("shore-old-claude-agent-"));
  const config: LoadedConfig = {
    app: defaultAppConfig(),
    models: emptyCatalog(),
    providers: ProviderRegistry.fromSection(providers),
    rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  for (const character of ["ada", "grace"]) {
    const workspace = join(config.dirs.config, "characters", character, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), character);
  }
  await mkdir(config.dirs.data, { recursive: true });
  initializeDatabase(config.dirs.data);
  addCalls(config, calls);
  return config;
}

function addCalls(config: LoadedConfig, calls: readonly Call[]): void {
  const db = new Database(ledgerPath(config));
  const insert = db.query(
    `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
     VALUES ('2026-09-20T00:00:00.000Z', ?1, ?2, 'subscription', 'claude-opus-5-5', 'message', 1000, 100, 0, 0, 100, 10, 'end_turn', 0, ?3, ?4)`,
  );
  for (const call of calls) {
    insert.run(call.character ?? "ada", call.provider, call.cost_source ?? "pricing_catalog", call.total_cost ?? null);
  }
  db.close();
}

const ledgerPath = (config: LoadedConfig): string => join(config.dirs.data, "shore.db");

async function start(config: LoadedConfig): Promise<void> {
  const runtime = await createRuntime({ config, providers: {}, env: {} });
  await runtime.autonomy.shutdown();
  await runtime.shutdown();
  closeLedgers();
}

function callsIn(config: LoadedConfig): Array<{ provider: string; cost_source: string; total_cost: number | null }> {
  const db = new Database(ledgerPath(config), { readonly: true });
  const calls = db.query("SELECT provider, cost_source, total_cost FROM calls ORDER BY id").all() as Array<{
    provider: string;
    cost_source: string;
    total_cost: number | null;
  }>;
  db.close();
  return calls;
}

test("the first start records old claude_agent calls as subscription calls at $0, and no other call changes", async () => {
  const others: Call[] = [
    { provider: "zai" },
    { provider: "deepseek" },
    { provider: "electronhub-anthropic" },
    { provider: "anthropic", total_cost: 3.5 },
    { provider: "openai", cost_source: "provider_reported", total_cost: 1.75 },
    { provider: "claude_agent", cost_source: "provider_reported", total_cost: 2.25 },
  ];
  const config = await installWith([OLD_SUBSCRIPTION_CALL, { provider: "claude_agent", character: "grace" }, ...others]);

  await start(config);

  expect(callsIn(config)).toEqual([
    { provider: "claude_agent", cost_source: "subscription", total_cost: 0 },
    { provider: "claude_agent", cost_source: "subscription", total_cost: 0 },
    { provider: "zai", cost_source: "pricing_catalog", total_cost: null },
    { provider: "deepseek", cost_source: "pricing_catalog", total_cost: null },
    { provider: "electronhub-anthropic", cost_source: "pricing_catalog", total_cost: null },
    { provider: "anthropic", cost_source: "pricing_catalog", total_cost: 3.5 },
    { provider: "openai", cost_source: "provider_reported", total_cost: 1.75 },
    { provider: "claude_agent", cost_source: "provider_reported", total_cost: 2.25 },
  ]);
  expect(costSourceTotals(required(ledgerFor(ledgerPath(config))).database, {}).find((source) => source.cost_source === "subscription"))
    .toEqual({ cost_source: "subscription", calls: 2, unpriced_calls: 0, total_cost: 0 });
});

test("a sweep stops reading them, so a subscription-only install stops fetching catalogs for them", async () => {
  const config = await installWith([OLD_SUBSCRIPTION_CALL]);
  await start(config);

  const fetched = spyOn(globalThis, "fetch");
  try {
    expect(await backfillLedgerCosts(ledgerPath(config))).toEqual({ updated: 0, total: 0, failures: [] });
    expect(fetched).not.toHaveBeenCalled();
  } finally {
    fetched.mockRestore();
  }
});

test("an install billing claude_agent per call keeps them unpriced, even after it later turns the subscription on", async () => {
  const unpriced = [{ provider: "claude_agent", cost_source: "pricing_catalog", total_cost: null }];
  const config = await installWith([OLD_SUBSCRIPTION_CALL], { claude_agent: { subscription: false } });

  await start(config);
  expect(callsIn(config)).toEqual(unpriced);

  await start({ ...config, providers: ProviderRegistry.fromSection({ claude_agent: { subscription: true } }) });
  expect(callsIn(config)).toEqual(unpriced);
});

test("an install with nothing to record at its first start never relabels a call that lands with no cost later", async () => {
  const config = await installWith([]);
  await start(config);

  addCalls(config, [OLD_SUBSCRIPTION_CALL]);
  await start(config);

  expect(callsIn(config)).toEqual([{ provider: "claude_agent", cost_source: "pricing_catalog", total_cost: null }]);
});

test("a character whose own config bills claude_agent per call keeps its calls unpriced", async () => {
  const config = await installWith([OLD_SUBSCRIPTION_CALL, { provider: "claude_agent", character: "grace" }]);
  await writeFile(join(config.dirs.config, "characters", "grace", "config.toml"), "[providers.claude_agent]\nsubscription = false\n");

  await start(config);

  expect(callsIn(config)).toEqual([
    { provider: "claude_agent", cost_source: "subscription", total_cost: 0 },
    { provider: "claude_agent", cost_source: "pricing_catalog", total_cost: null },
  ]);
});

test("a start that can't write them still starts, and the next start records them", async () => {
  const config = await installWith([OLD_SUBSCRIPTION_CALL]);
  const blocking = new Database(ledgerPath(config));
  blocking.run("CREATE TRIGGER refuse_call_updates BEFORE UPDATE ON calls BEGIN SELECT RAISE(ABORT, 'disk trouble'); END");

  await start(config);
  expect(callsIn(config)).toEqual([{ provider: "claude_agent", cost_source: "pricing_catalog", total_cost: null }]);

  blocking.run("DROP TRIGGER refuse_call_updates");
  blocking.close();
  await start(config);
  expect(callsIn(config)).toEqual([{ provider: "claude_agent", cost_source: "subscription", total_cost: 0 }]);
});
