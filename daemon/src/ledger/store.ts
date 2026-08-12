import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import {
  CacheTracker,
  CacheTrackers,
  type Anomaly,
  type CacheState,
  type Observation,
} from "../cache/tracker.ts";
import { isAnthropicPricing, PricingEngine, type ModelPricing, type PricingStore } from "./pricing.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  TEXT    NOT NULL,
    character           TEXT    NOT NULL,
    provider            TEXT    NOT NULL,
    api_key_name        TEXT,
    model               TEXT    NOT NULL,
    call_type           TEXT    NOT NULL,
    input_tokens        INTEGER NOT NULL,
    output_tokens       INTEGER NOT NULL,
    cache_read_tokens   INTEGER NOT NULL,
    cache_write_tokens  INTEGER NOT NULL,
    cache_ttl           TEXT    DEFAULT '1h',
    reasoning_effort    TEXT,
    tool_surface        TEXT,
    total_ms            INTEGER NOT NULL,
    ttft_ms             INTEGER NOT NULL,
    finish_reason       TEXT    NOT NULL,
    thinking_enabled    INTEGER NOT NULL,
    cache_state         TEXT,
    cache_anomaly       TEXT,
    input_cost          REAL,
    output_cost         REAL,
    cache_read_cost     REAL,
    cache_write_cost    REAL,
    cost_source         TEXT    DEFAULT 'pricing_catalog',
    total_cost          REAL
);

CREATE TABLE IF NOT EXISTS call_attempts (
    id                  TEXT PRIMARY KEY,
    started_at          TEXT NOT NULL,
    finished_at         TEXT,
    status              TEXT NOT NULL,
    character           TEXT NOT NULL,
    provider            TEXT NOT NULL,
    api_key_name        TEXT,
    model               TEXT NOT NULL,
    call_type           TEXT NOT NULL,
    estimated_cost      REAL,
    call_id             INTEGER,
    error               TEXT,
    FOREIGN KEY (call_id) REFERENCES calls(id)
);

CREATE TABLE IF NOT EXISTS pricing (
    model_id              TEXT PRIMARY KEY,
    input_per_token       REAL NOT NULL,
    output_per_token      REAL NOT NULL,
    cache_read_per_token  REAL NOT NULL,
    cache_write_per_token REAL NOT NULL,
    fetched_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_budget_warnings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_name    TEXT NOT NULL,
    period_start   TEXT NOT NULL,
    threshold      TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (budget_name, period_start, threshold)
);

CREATE INDEX IF NOT EXISTS idx_calls_ts        ON calls (ts);
CREATE INDEX IF NOT EXISTS idx_calls_character ON calls (character);
CREATE INDEX IF NOT EXISTS idx_calls_provider  ON calls (provider);
CREATE INDEX IF NOT EXISTS idx_calls_anomaly   ON calls (cache_anomaly) WHERE cache_anomaly IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_attempts_status ON call_attempts (status, started_at);
CREATE INDEX IF NOT EXISTS idx_usage_budget_warnings_window
    ON usage_budget_warnings (budget_name, period_start);
`;

const MIGRATIONS: readonly string[] = [
  "ALTER TABLE calls ADD COLUMN cache_ttl TEXT DEFAULT '1h'",
  "ALTER TABLE calls ADD COLUMN api_key_name TEXT",
  "CREATE INDEX IF NOT EXISTS idx_calls_api_key ON calls (provider, api_key_name)",
  "ALTER TABLE calls ADD COLUMN cost_source TEXT DEFAULT 'pricing_catalog'",
  `UPDATE calls
      SET cost_source = 'provider_reported'
    WHERE total_cost IS NOT NULL
      AND input_cost IS NULL
      AND output_cost IS NULL
      AND cache_read_cost IS NULL
      AND cache_write_cost IS NULL`,
  `CREATE TABLE IF NOT EXISTS usage_budget_warnings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      budget_name    TEXT NOT NULL,
      period_start   TEXT NOT NULL,
      threshold      TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      UNIQUE (budget_name, period_start, threshold)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_budget_warnings_window
      ON usage_budget_warnings (budget_name, period_start)`,
  "ALTER TABLE calls ADD COLUMN reasoning_effort TEXT",
  "ALTER TABLE calls ADD COLUMN tool_surface TEXT",
  `CREATE TABLE IF NOT EXISTS call_attempts (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      character TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key_name TEXT,
      model TEXT NOT NULL,
      call_type TEXT NOT NULL,
      estimated_cost REAL,
      call_id INTEGER,
      error TEXT,
      FOREIGN KEY (call_id) REFERENCES calls(id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_call_attempts_status ON call_attempts (status, started_at)",
];

function migrate(db: Database): void {
  for (const statement of MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (e) {
      if (!String(e).includes("duplicate column")) throw e;
    }
  }
}

function migrateCallAttempts(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS call_attempts (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    character TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_key_name TEXT,
    model TEXT NOT NULL,
    call_type TEXT NOT NULL,
    estimated_cost REAL,
    call_id INTEGER,
    error TEXT,
    FOREIGN KEY (call_id) REFERENCES calls(id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_call_attempts_status ON call_attempts (status, started_at)");
}

const SUBSCRIPTION_PROVIDERS = new Set(["opencode-go"]);

export const isSubscriptionProvider = (provider: string): boolean =>
  SUBSCRIPTION_PROVIDERS.has(provider);

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd?: number | undefined;
}

export interface Timing {
  total_ms: number;
  time_to_first_token_ms: number;
}

export interface RecordCall {
  provider: string;
  api_key_name?: string | undefined;
  model: string;
  call_type: string;
  character: string;
  usage: Usage;
  timing: Timing;
  finish_reason: string;
  thinking_enabled: boolean;
  cache_ttl?: string | undefined;
  reasoning_effort?: string | undefined;
  tool_surface?: string | undefined;
}

export interface CallRow {
  id?: number;
  ts: string;
  character: string;
  provider: string;
  api_key_name: string | null;
  model: string;
  call_type: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_ttl: string | null;
  reasoning_effort: string | null;
  tool_surface: string | null;
  total_ms: number;
  ttft_ms: number;
  finish_reason: string;
  thinking_enabled: number;
  cache_state: string | null;
  cache_anomaly: string | null;
  input_cost: number | null;
  output_cost: number | null;
  cache_read_cost: number | null;
  cache_write_cost: number | null;
  cost_source: string | null;
  total_cost: number | null;
}

const INSERT_SQL = `INSERT INTO calls (
  ts, character, provider, api_key_name, model, call_type,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  cache_ttl, reasoning_effort, tool_surface, total_ms, ttft_ms, finish_reason,
  thinking_enabled, cache_state, cache_anomaly,
  input_cost, output_cost, cache_read_cost, cache_write_cost,
  cost_source, total_cost
) VALUES (
  $ts, $character, $provider, $api_key_name, $model, $call_type,
  $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens,
  $cache_ttl, $reasoning_effort, $tool_surface, $total_ms, $ttft_ms, $finish_reason,
  $thinking_enabled, $cache_state, $cache_anomaly,
  $input_cost, $output_cost, $cache_read_cost, $cache_write_cost,
  $cost_source, $total_cost
)`;

const LAST_ANTHROPIC_CALL_SQL = `SELECT ts, model, thinking_enabled, cache_read_tokens, tool_surface
  FROM calls
 WHERE character = $character
   AND (provider = 'anthropic' OR model LIKE 'anthropic/%')
   AND call_type != 'compaction'
 ORDER BY id DESC
 LIMIT 1`;

interface SeedRow {
  ts: string;
  model: string;
  thinking_enabled: number;
  cache_read_tokens: number;
  tool_surface: string | null;
}

export class Ledger {
  readonly #db: Database;
  readonly #trackers = new CacheTrackers();
  readonly #pricing: PricingEngine;
  #ttlSecs = 3600;

  private constructor(db: Database, pricing?: PricingEngine) {
    this.#db = db;
    this.#pricing = pricing ?? new PricingEngine(sqlitePricingStore(db));
  }

  static create(path: string, pricing?: PricingEngine): Ledger {
    const db = new Database(path, { create: true, readwrite: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    migrate(db);
    db.query("UPDATE call_attempts SET status = 'unresolved' WHERE status = 'pending'").run();
    return new Ledger(db, pricing);
  }

  static open(path: string, pricing?: PricingEngine): Ledger {
    const db = new Database(path, { create: false, readwrite: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const table = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'calls'")
      .get();
    if (!table) {
      db.close();
      throw new Error(`${path} has no 'calls' table — the daemon owns the schema and creates it`);
    }
    migrateCallAttempts(db);
    return new Ledger(db, pricing);
  }

  get pricing(): PricingEngine {
    return this.#pricing;
  }

  get trackers(): CacheTrackers {
    return this.#trackers;
  }

  setMaxIdleSecs(secs: number): void {
    this.#trackers.setMaxIdleSecs(secs);
  }

  setCacheTtlSecs(secs: number): void {
    this.#ttlSecs = secs;
  }

  get cacheTtlSecs(): number {
    return this.#ttlSecs;
  }

  get database(): Database {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }

  beginAttempt(
    record: Pick<RecordCall, "provider" | "api_key_name" | "model" | "call_type" | "character">,
    estimatedCost?: number,
    now: () => Date = () => new Date(),
  ): string {
    const id = randomUUID();
    this.#db.query(
      `INSERT INTO call_attempts (
         id, started_at, status, character, provider, api_key_name, model, call_type, estimated_cost
       ) VALUES ($id, $started_at, 'pending', $character, $provider, $api_key_name,
                 $model, $call_type, $estimated_cost)`,
    ).run({
      $id: id,
      $started_at: now().toISOString(),
      $character: record.character,
      $provider: record.provider,
      $api_key_name: record.api_key_name ?? null,
      $model: record.model,
      $call_type: record.call_type,
      $estimated_cost: estimatedCost ?? null,
    });
    return id;
  }

  record(record: RecordCall, now: () => Date = () => new Date(), attemptId?: string): CallRow {
    const ts = now().toISOString();
    const [cache_state, cache_anomaly] = this.#trackCacheState(record, ts);
    const row = this.#buildRow(record, ts, cache_state, cache_anomaly);
    const insert = () => this.#db.query(INSERT_SQL).run({
      $ts: row.ts,
      $character: row.character,
      $provider: row.provider,
      $api_key_name: row.api_key_name,
      $model: row.model,
      $call_type: row.call_type,
      $input_tokens: row.input_tokens,
      $output_tokens: row.output_tokens,
      $cache_read_tokens: row.cache_read_tokens,
      $cache_write_tokens: row.cache_write_tokens,
      $cache_ttl: row.cache_ttl,
      $reasoning_effort: row.reasoning_effort,
      $tool_surface: row.tool_surface,
      $total_ms: row.total_ms,
      $ttft_ms: row.ttft_ms,
      $finish_reason: row.finish_reason,
      $thinking_enabled: row.thinking_enabled,
      $cache_state: row.cache_state,
      $cache_anomaly: row.cache_anomaly,
      $input_cost: row.input_cost,
      $output_cost: row.output_cost,
      $cache_read_cost: row.cache_read_cost,
      $cache_write_cost: row.cache_write_cost,
      $cost_source: row.cost_source,
      $total_cost: row.total_cost,
    });
    if (attemptId === undefined) {
      const result = insert();
      row.id = Number(result.lastInsertRowid);
      return row;
    }
    this.#db.transaction(() => {
      const result = insert();
      row.id = Number(result.lastInsertRowid);
      this.#db.query(
        `UPDATE call_attempts
            SET status = $status, finished_at = $finished_at, call_id = $call_id,
                error = $error
          WHERE id = $id AND status = 'pending'`,
      ).run({
        $status: record.finish_reason === "error" ? "error" :
          record.finish_reason === "cancelled" ? "cancelled" : "completed",
        $finished_at: row.ts,
        $call_id: row.id,
        $error: record.finish_reason === "error" ? "provider call failed" : null,
        $id: attemptId,
      });
    })();
    return row;
  }

  #seedIfNeeded(character: string): void {
    if (!this.#trackers.needsSeed(character)) return;
    const seed = this.#db.query(LAST_ANTHROPIC_CALL_SQL).get({ $character: character }) as
      | SeedRow
      | null;
    if (!seed) {
      this.#trackers.forCharacter(character, this.#ttlSecs);
      return;
    }
    this.#trackers.seed(
      character,
      CacheTracker.reconstruct(
        seed.ts,
        seed.model,
        seed.thinking_enabled !== 0,
        seed.cache_read_tokens,
        this.#ttlSecs,
        undefined,
        seed.tool_surface ?? undefined,
      ),
    );
  }

  #trackCacheState(record: RecordCall, ts: string): [string | null, string | null] {
    if (record.finish_reason === "cancelled") return [null, null];

    const noCacheSignal =
      record.usage.cache_read_tokens === 0 && record.usage.cache_creation_tokens === 0;
    if (record.finish_reason === "error" && noCacheSignal) return [null, null];

    this.#seedIfNeeded(record.character);

    if (!isAnthropicPricing(record.provider, record.model)) {
      this.#feedForeignCall(record, ts);
      const hasMetrics =
        record.usage.cache_read_tokens > 0 || record.usage.cache_creation_tokens > 0;
      if (!hasMetrics) return [null, null];
      return [record.usage.cache_read_tokens > 0 ? "warm" : "cold", null];
    }

    const observation: Observation = {
      ts,
      model: record.model,
      thinking_enabled: record.thinking_enabled,
      cache_read_tokens: record.usage.cache_read_tokens,
      cache_write_tokens: record.usage.cache_creation_tokens,
      call_type: record.call_type,
      tool_surface: record.tool_surface,
    };
    const result = this.#trackers.forCharacter(record.character, this.#ttlSecs).observe(observation);
    const state: CacheState = result.state;
    const anomaly: Anomaly | undefined = result.anomaly;
    return [state, anomaly ?? null];
  }

  #feedForeignCall(record: RecordCall, ts: string): void {
    if (this.#trackers.needsSeed(record.character)) return;
    const tracker = this.#trackers.forCharacter(record.character, this.#ttlSecs);
    if (record.call_type === "compaction") {
      tracker.observe({
        ts,
        model: record.model,
        thinking_enabled: record.thinking_enabled,
        cache_read_tokens: record.usage.cache_read_tokens,
        cache_write_tokens: record.usage.cache_creation_tokens,
        call_type: record.call_type,
      });
    } else if (record.call_type === "message" || record.call_type === "tool_loop") {
      tracker.noteActivity(ts);
    }
  }

  #buildRow(
    record: RecordCall,
    ts: string,
    cache_state: string | null,
    cache_anomaly: string | null,
  ): CallRow {
    const subscription = isSubscriptionProvider(record.provider);

    const priced = subscription
      ? undefined
      : this.#pricing.cost({
          provider: record.provider,
          model: record.model,
          input_tokens: record.usage.input_tokens,
          output_tokens: record.usage.output_tokens,
          cache_read_tokens: record.usage.cache_read_tokens,
          cache_write_tokens: record.usage.cache_creation_tokens,
          cache_ttl: record.cache_ttl,
        });

    const providerTotal = subscription ? undefined : record.usage.total_cost_usd;
    const cost_source = subscription
      ? "subscription"
      : providerTotal !== undefined
        ? "provider_reported"
        : "pricing_catalog";
    const breakdown = providerTotal === undefined ? priced : undefined;

    return {
      ts,
      character: record.character,
      provider: record.provider,
      api_key_name: record.api_key_name ?? null,
      model: record.model,
      call_type: record.call_type,
      input_tokens: record.usage.input_tokens,
      output_tokens: record.usage.output_tokens,
      cache_read_tokens: record.usage.cache_read_tokens,
      cache_write_tokens: record.usage.cache_creation_tokens,
      cache_ttl: record.cache_ttl ?? null,
      reasoning_effort: record.reasoning_effort ?? null,
      tool_surface: record.tool_surface ?? null,
      total_ms: record.timing.total_ms,
      ttft_ms: record.timing.time_to_first_token_ms,
      finish_reason: record.finish_reason,
      thinking_enabled: record.thinking_enabled ? 1 : 0,
      cache_state,
      cache_anomaly,
      input_cost: breakdown?.input ?? null,
      output_cost: breakdown?.output ?? null,
      cache_read_cost: breakdown?.cache_read ?? null,
      cache_write_cost: breakdown?.cache_write ?? null,
      cost_source,
      total_cost: providerTotal ?? priced?.total ?? (subscription ? 0 : null),
    };
  }
}

function sqlitePricingStore(db: Database): PricingStore {
  return {
    get(modelId) {
      const row = db
        .query(
          `SELECT input_per_token, output_per_token, cache_read_per_token, cache_write_per_token
             FROM pricing WHERE model_id = $id`,
        )
        .get({ $id: modelId }) as ModelPricing | null;
      return row ?? undefined;
    },
    put(modelId, pricing) {
      db.query(
        `INSERT OR REPLACE INTO pricing
           (model_id, input_per_token, output_per_token,
            cache_read_per_token, cache_write_per_token, fetched_at)
         VALUES ($id, $input, $output, $read, $write, $at)`,
      ).run({
        $id: modelId,
        $input: pricing.input_per_token,
        $output: pricing.output_per_token,
        $read: pricing.cache_read_per_token,
        $write: pricing.cache_write_per_token,
        $at: new Date().toISOString(),
      });
    },
    clear() {
      db.run("DELETE FROM pricing");
    },
  };
}
