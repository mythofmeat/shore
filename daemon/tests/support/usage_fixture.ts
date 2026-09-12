import { join } from "node:path";
import type { ShoreRuntime } from "../../src/runtime.ts";
import { ledgerFor } from "../../src/ledger/record.ts";
import { nanoGptSubscriptionPath, writeNanoGptSubscription } from "../../src/llm/nanogpt_subscription.ts";

export const USAGE_FIXTURE_CONFIG = `
[usage]
timezone = "utc"
[[usage.budgets]]
name = "Nova monthly"
period = "month"
cost_usd = 2.0
warn_at = [0.5, 1.0]
limit = "warn"
character = "nova"
pace_period = "day"
`;

export async function seedUsageFixture(runtime: ShoreRuntime, ts = new Date(Date.now() - 1000).toISOString()): Promise<void> {
  const config = runtime.registry.globalConfig();
  const ledger = ledgerFor(join(config.dirs.data, "shore.db"));
  if (ledger === null) throw new Error("Usage fixture requires a ledger");
  const insert = ledger.database.query(`INSERT INTO calls (ts,character,provider,api_key_name,model,call_type,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_ms,ttft_ms,finish_reason,thinking_enabled,cache_state,cache_anomaly,cost_source,total_cost,cache_state_reason) VALUES (?,?,?,?,?,?,1000,100,?,?,100,10,'end_turn',0,?,?,?,?,?)`);
  insert.run("2000-01-01T12:00:00.000Z", "nova", "anthropic", "default", "usage-model-a", "tool_loop", 100, 0, "warm", null, "pricing_catalog", 9, null);
  insert.run(ts, "nova", "anthropic", "default", "usage-model-a", "message", 1000, 0, "warm", null, "pricing_catalog", 3.5, null);
  insert.run(ts, "nova", "anthropic", "batch", "usage-model-a", "heartbeat", 0, 2500, "cold", "unexpected_write", null, null, "prefix changed");
  insert.run(ts, "other", "openai", null, "usage-model-b", "subagent", 0, 0, "not_applicable", null, "provider_reported", 1.75, "provider does not expose cache usage");
  ledger.database.query("INSERT INTO call_attempts (id,started_at,status,character,provider,api_key_name,model,call_type,estimated_cost) VALUES (?,?,?,?,?,?,?,?,?)").run("usage-unresolved", ts, "unresolved", "nova", "anthropic", "default", "usage-model-a", "message", 0.25);
  runtime.callStore?.recordHttpCall({ call_id: "usage-limits", seq: 0, ts: new Date(ts), character: "nova", call_type: "message", rid: "usage-limits", method: "POST", url: "https://api.anthropic.com/v1/messages", status: 200, status_text: "OK", duration_ms: 1, request_headers: [], request_body: new Uint8Array(), response_headers: [["anthropic-ratelimit-requests-limit", "1000"], ["anthropic-ratelimit-requests-remaining", "12"], ["anthropic-ratelimit-input-tokens-limit", "100000"], ["anthropic-ratelimit-input-tokens-remaining", "1200"], ["anthropic-ratelimit-requests-reset", "2099-01-01T00:00:00Z"]], response_body: new Uint8Array() });
  await writeNanoGptSubscription(nanoGptSubscriptionPath(config.dirs.cache), { version: 1, fetched_at: ts, active: true, state: "active", weeklyInputTokens: { used: 12000000, remaining: 48000000, limit: 60000000, resetAt: "2099-01-07T00:00:00Z" }, routing: { recommendedMode: "subscription" } });
}
