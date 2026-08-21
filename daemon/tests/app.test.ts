import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import fixture from "./config_fixtures/app.json" with { type: "json" };

import { pathsSetBy, replayOntoCurrentDefaults } from "./config_delta.ts";

import {
  anyToolEnabled,
  budgetPaceAction,
  budgetPaceWarnAt,
  budgetPeriodRank,
  defaultAppConfig,
  defaultToolsConfig,
  mapKeysInOrder,
  numDaysFromMonday,
  parseAppConfig,
  parseThinkingReplay,
  resolveBackgroundModelName,
  resolveDisplayName,
  resultCharsFor,
  subagentEnabled,
  timeoutFor,
  toolEnabled,
  toolPatternMatches,
  validateCompaction,
  type AppConfig,
  type BackgroundTask,
  type BudgetWeekday,
  type DefaultsConfig,
  type ToolsConfig,
  type UsageBudgetPeriod,
} from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";

function canonical(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof ConfigDuration) return value.toString();
  if (value instanceof Map) {
    const map = value as ReadonlyMap<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of map) out[k] = canonical(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = canonical(v);
    return out;
  }
  return value;
}

function mapOrderOf(config: AppConfig): [string, string[]][] {
  const out: [string, string[]][] = [
    ["subagents", [...config.subagents.keys()]],
    ["mcp", [...config.mcp.keys()]],
    ["tools.config", [...config.tools.config.keys()]],
  ];
  for (const [name, server] of config.mcp) {
    out.push([`mcp.${name}.env`, [...server.env.keys()]]);
  }
  return out;
}

function parseToml(src: string): unknown {
  return Bun.TOML.parse(src);
}

const DAEMON_FIELDS_REMOVED_SINCE = ["unsafe_allow_remote_access", "allowed_hosts"] as const;

function withoutRemovedDaemonFields(value: unknown): unknown {
  const daemon = (value as { daemon?: unknown } | null)?.daemon;
  if (typeof daemon !== "object" || daemon === null) return value;
  const copy = { ...(daemon as Record<string, unknown>) };
  for (const key of DAEMON_FIELDS_REMOVED_SINCE) delete copy[key];
  return { ...(value as object), daemon: copy };
}

function withoutRemovedUsageFields(value: unknown): unknown {
  const usage = (value as { usage?: unknown } | null)?.usage;
  if (typeof usage !== "object" || usage === null) return value;
  const { spike_warnings: _removed, ...current } = usage as Record<string, unknown>;
  return { ...(value as object), usage: current };
}

const withoutRemovedFields = (value: unknown): unknown =>
  withoutRemovedUsageFields(withoutRemovedDaemonFields(value));

const BUDGET_FIELDS_ADDED_SINCE = ["warn_action", "pace_warn_action"] as const;

function withoutAddedBudgetFields(value: unknown): unknown {
  const budgets = (value as { usage?: { budgets?: unknown } } | null)?.usage?.budgets;
  if (!Array.isArray(budgets)) return value;
  return {
    ...(value as object),
    usage: {
      ...(value as { usage: object }).usage,
      budgets: budgets.map((b) => {
        const copy = { ...(b as Record<string, unknown>) };
        for (const key of BUDGET_FIELDS_ADDED_SINCE) delete copy[key];
        return copy;
      }),
    },
  };
}

const RUST_BUDGET_FIELD_COUNT = 18;

function withRustBudgetFieldCount(err: string): string {
  return err.replace(
    `UsageBudgetConfig with ${RUST_BUDGET_FIELD_COUNT + BUDGET_FIELDS_ADDED_SINCE.length} elements`,
    `UsageBudgetConfig with ${RUST_BUDGET_FIELD_COUNT} elements`,
  );
}

const MCP_FIELDS_ADDED_SINCE = ["headers"] as const;

function withoutAddedMcpFields(value: unknown): unknown {
  const mcp = (value as { mcp?: unknown } | null)?.mcp;
  if (mcp === null || typeof mcp !== "object") return value;
  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(mcp as Record<string, unknown>)) {
    const copy = { ...(server as Record<string, unknown>) };
    for (const key of MCP_FIELDS_ADDED_SINCE) delete copy[key];
    servers[name] = copy;
  }
  return { ...(value as object), mcp: servers };
}

const RUST_MCP_FIELD_COUNT = 5;

function withRustMcpFields(err: string): string {
  return err.replace("`cwd`, `url`, `headers`", "`cwd`, `url`");
}

function withRustMcpFieldCount(err: string): string {
  return withRustMcpFields(
    err.replace(
      `McpServerConfig with ${RUST_MCP_FIELD_COUNT + MCP_FIELDS_ADDED_SINCE.length} elements`,
      `McpServerConfig with ${RUST_MCP_FIELD_COUNT} elements`,
    ),
  );
}

const SUBAGENT_FIELDS_ADDED_SINCE = ["timeout"] as const;

function withoutAddedSubagentFields(value: unknown): unknown {
  const subagents = (value as { subagents?: unknown } | null)?.subagents;
  if (subagents === null || typeof subagents !== "object") return value;
  const specs: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(subagents as Record<string, unknown>)) {
    const copy = { ...(spec as Record<string, unknown>) };
    for (const key of SUBAGENT_FIELDS_ADDED_SINCE) delete copy[key];
    specs[name] = copy;
  }
  return { ...(value as object), subagents: specs };
}

const RUST_SUBAGENT_FIELD_COUNT = 5;

function withRustSubagentFields(err: string): string {
  return err
    .replace("`model`, `max_iterations`, `timeout`", "`model`, `max_iterations`")
    .replace(
      `SubagentConfig with ${RUST_SUBAGENT_FIELD_COUNT + SUBAGENT_FIELDS_ADDED_SINCE.length} elements`,
      `SubagentConfig with ${RUST_SUBAGENT_FIELD_COUNT} elements`,
    );
}

const CACHE_KEYS_MOVED_SINCE = {
  keepalive_max: ["behavior", "autonomy", "cache_keepalive_max"],
  forensics: ["advanced", "cache_forensics"],
} as const;

function withCacheSectionMoved(value: unknown): unknown {
  const v = value as Record<string, Record<string, Record<string, unknown>>> | null;
  const autonomy = v?.behavior?.autonomy;
  const advanced = v?.advanced;
  if (autonomy === undefined || advanced === undefined) return value;
  if (!("cache_keepalive_max" in autonomy) || !("cache_forensics" in advanced)) return value;

  const trimmedAutonomy = { ...autonomy };
  delete trimmedAutonomy.cache_keepalive_max;
  const trimmedAdvanced = { ...advanced };
  delete trimmedAdvanced.cache_forensics;

  return {
    ...(value as object),
    behavior: { ...required(v).behavior, autonomy: trimmedAutonomy },
    advanced: trimmedAdvanced,
    cache: {
      keepalive_max: autonomy.cache_keepalive_max,
      forensics: advanced.cache_forensics,
    },
  };
}

function tomlWithCacheSectionMoved(src: string): string {
  const assignment = /^cache_keepalive_max = (.+)$/m;
  const match = assignment.exec(src);
  if (match === null) return src;
  const without = src.replace(assignment, "").replace(/\n{3,}/g, "\n\n");
  return `${without}\n[cache]\nkeepalive_max = ${match[1]}\n`;
}

const CONNECTIONS_FIELDS_REINTRODUCED_SINCE = ["matrix"] as const;

function withoutReintroducedConnectionsFields(value: unknown): unknown {
  const connections = (value as { connections?: unknown } | null)?.connections;
  if (typeof connections !== "object" || connections === null) return value;
  const copy = { ...(connections as Record<string, unknown>) };
  for (const key of CONNECTIONS_FIELDS_REINTRODUCED_SINCE) delete copy[key];
  return { ...(value as object), connections: copy };
}

const withoutAddedFields = (value: unknown): unknown =>
  withoutReintroducedConnectionsFields(
    withoutAddedSubagentFields(withoutAddedMcpFields(withoutAddedBudgetFields(value))),
  );

function withRustCacheFields(err: string): string {
  return err
    .replace("`memory`, `cache`, `connections`", "`memory`, `connections`")
    .replace(
      "expected `enabled` or `heartbeat`",
      "expected one of `enabled`, `heartbeat`, `cache_keepalive_max`",
    );
}

const withRustFieldCounts = (err: string): string =>
  withRustSubagentFields(
    withRustCacheFields(withRustMcpFieldCount(withRustBudgetFieldCount(err))),
  );

const DELIBERATELY_DIVERGENT = new Set([
  "the daemon section",
  "the removed matrix connection is rejected",
  "the removed embedded matrix connection is rejected",
  "the advanced section",
  "max_image_size = 0 disables resizing",
  "negative u64",
  "seq: AdvancedConfig",
  "seq: AdvancedConfig, at its minimum",
  "seq: LlmSidecarConfig",
  "seq: LlmSidecarConfig, at its minimum",
  "integer where a path is expected",
  "a full positional sequence",
  "usage budgets and spike warnings",
]);

const BUN_CANNOT_SEE = new Set([
  "datetime where a string is expected",
  "a float that happens to be whole is still a float",
  "exponent notation is a float too",
  "u64 fields hold values a double cannot",
]);

describe("the fixture is real", () => {
  test("the trimmed daemon fields really are ones it had", () => {
    const daemon = (fixture.defaults as { daemon: Record<string, unknown> }).daemon;
    for (const key of DAEMON_FIELDS_REMOVED_SINCE) {
      expect(Object.keys(daemon)).toContain(key);
    }
  });

  test("the trimmed usage field really is one it had", () => {
    const usage = (fixture.defaults as { usage: Record<string, unknown> }).usage;
    expect(Object.keys(usage)).toContain("spike_warnings");
  });

  test("the exempted budget fields really are ones it never had", () => {
    const text = JSON.stringify(fixture);
    for (const key of BUDGET_FIELDS_ADDED_SINCE) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(text).toContain(`UsageBudgetConfig with ${RUST_BUDGET_FIELD_COUNT} elements`);
  });

  test("the exempted mcp fields really are ones it never had", () => {
    const text = JSON.stringify(fixture);
    for (const key of MCP_FIELDS_ADDED_SINCE) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(text).toContain(`McpServerConfig with ${RUST_MCP_FIELD_COUNT} elements`);
  });

  test("the exempted subagent fields really are ones it never had", () => {
    const subagents = (fixture.defaults as { subagents: Record<string, object> }).subagents;
    for (const spec of Object.values(subagents)) {
      for (const key of SUBAGENT_FIELDS_ADDED_SINCE) {
        expect(Object.keys(spec)).not.toContain(key);
      }
    }
  });

  test("the moved cache keys really are ones it had, where it had them", () => {
    const defaults = fixture.defaults as object;
    for (const path of Object.values(CACHE_KEYS_MOVED_SINCE)) {
      let here: unknown = defaults;
      for (const key of path) {
        expect(Object.keys(here as object)).toContain(key);
        here = (here as Record<string, unknown>)[key];
      }
    }
    expect(Object.keys(defaults)).not.toContain("cache");
  });

  test("the moved keys kept the values the Rust defaulted them to", () => {
    const recorded = fixture.defaults as {
      behavior: { autonomy: { cache_keepalive_max: string } };
      advanced: { cache_forensics: boolean };
    };
    const cache = defaultAppConfig().cache;
    expect(cache.keepalive_max.toString()).toBe(recorded.behavior.autonomy.cache_keepalive_max);
    expect(cache.forensics).toBe(recorded.advanced.cache_forensics);
  });

  test("the reintroduced connections fields really are ones it never had", () => {
    const connections = (fixture.defaults as { connections: Record<string, unknown> }).connections;
    for (const key of CONNECTIONS_FIELDS_REINTRODUCED_SINCE) {
      expect(Object.keys(connections)).not.toContain(key);
    }
  });

  test("it records both parse paths, and they genuinely differ somewhere", () => {
    const disagreements = fixture.parse.filter(
      (c) => "doc_err" in c && c.doc_err !== c.table_err,
    );
    expect(disagreements.length).toBeGreaterThan(0);
  });
});

describe("AppConfig::default", () => {
  test("an empty document parses to exactly the defaults", () => {
    const parsed = parseAppConfig(parseToml(""));
    if ("err" in parsed) throw new Error(parsed.err);
    expect(canonical(parsed.ok)).toEqual(canonical(defaultAppConfig()));
  });

  test("the values an unconfigured shore runs on", () => {
    const app = defaultAppConfig();

    expect(app.defaults.stream).toBe(true);
    expect(app.memory.compaction.archive_after.asSecs()).toBe(0n);
    expect(app.memory.file_limits).toEqual({
      max_note_bytes: 8 * 1024,
      max_index_bytes: 16 * 1024,
      max_prompt_bytes: 64 * 1024,
    });
    expect(app.notifications.events.message_complete).toBe(true);
    expect(app.usage.allow_compaction_over_budget).toBe(false);
  });

  test("memory file limits are configurable independently", () => {
    const parsed = parseAppConfig(
      parseToml(
        "[memory.file_limits]\n" +
          "max_note_bytes = 4096\n" +
          "max_index_bytes = 12288\n" +
          "max_prompt_bytes = 131072\n",
      ),
    );
    if ("err" in parsed) throw new Error(parsed.err);
    expect(parsed.ok.memory.file_limits).toEqual({
      max_note_bytes: 4096,
      max_index_bytes: 12288,
      max_prompt_bytes: 131072,
    });
  });
});

function expectationFor(want: unknown, toml: string): unknown {
  return replayOntoCurrentDefaults(
    withCacheSectionMoved(withoutRemovedFields(want)),
    withCacheSectionMoved(withoutRemovedFields(fixture.defaults)),
    withoutAddedFields(canonical(defaultAppConfig())),
    pathsSetBy(parseToml(toml)),
  );
}

describe("parsing config.toml", () => {
  for (const c of fixture.parse) {
    if (BUN_CANNOT_SEE.has(c.name) || DELIBERATELY_DIVERGENT.has(c.name)) continue;

    test(c.name, () => {
      const toml = tomlWithCacheSectionMoved(c.toml);
      const parsed = parseAppConfig(parseToml(toml));

      const want: { ok: unknown } | { err: string } =
        "ok" in c
          ? { ok: c.ok }
          : "table" in c
            ? (c.table)
            : { err: c.table_err };

      if ("err" in want) {
        if ("ok" in parsed) throw new Error("expected a parse error, got a config");
        expect(withRustFieldCounts(parsed.err)).toBe(want.err);
      } else {
        if ("err" in parsed) throw new Error(`expected a parse, got: ${parsed.err}`);
        expect(withoutAddedFields(canonical(parsed.ok))).toEqual(
          expectationFor(want.ok, toml),
        );
      }
    });
  }

  test("a config still setting the deleted [daemon] keys is now rejected", () => {
    const c = fixture.parse.find((x) => x.name === "the daemon section");
    expect(c).toBeDefined();

    const parsed = parseAppConfig(parseToml(required(c).toml));
    expect("err" in parsed).toBe(true);
    expect((parsed as { err: string }).err).toBe(
      "unknown field `allowed_hosts`, expected `addr`",
    );

    const ok = parseAppConfig(parseToml(`[daemon]\naddr = "0.0.0.0:9999"\n`));
    if ("err" in ok) throw new Error(ok.err);
    expect(ok.ok.daemon).toEqual({ addr: "0.0.0.0:9999" });
  });

  test("a config still setting usage spike warnings is now rejected", () => {
    const c = fixture.parse.find((x) => x.name === "usage budgets and spike warnings");
    expect(c).toBeDefined();

    const parsed = parseAppConfig(parseToml(required(c).toml));
    expect("err" in parsed).toBe(true);
    expect((parsed as { err: string }).err).toBe(
      "unknown field `spike_warnings`, expected one of `timezone`, " +
        "`allow_compaction_over_budget`, `budgets`",
    );
  });

  test("a config still setting the deleted [advanced] keys is now rejected", () => {
    const c = fixture.parse.find((x) => x.name === "the advanced section");
    expect(c).toBeDefined();

    const parsed = parseAppConfig(parseToml(required(c).toml));
    expect("err" in parsed).toBe(true);
    expect((parsed as { err: string }).err).toBe(
      "unknown field `api_payload_logging`, expected `max_retries` or `retry_backoff`",
    );
  });

  test("`max_image_size` is rejected by name now that nothing resizes", () => {
    for (const name of ["max_image_size = 0 disables resizing", "negative u64"]) {
      const c = fixture.parse.find((x) => x.name === name);
      if (c === undefined) throw new Error(`fixture case missing: ${name}`);

      const parsed = parseAppConfig(parseToml(c.toml));
      expect("err" in parsed).toBe(true);
      expect((parsed as { err: string }).err).toBe(
        "unknown field `max_image_size`, expected `max_retries` or `retry_backoff`",
      );
    }
  });

  test("a config still setting the moved cache keys at the old paths is rejected", () => {
    const stale = parseAppConfig(parseToml(`[behavior.autonomy]\ncache_keepalive_max = "6h"\n`));
    expect("err" in stale).toBe(true);
    expect((stale as { err: string }).err).toBe(
      "unknown field `cache_keepalive_max`, expected `enabled` or `heartbeat`",
    );

    const staleForensics = parseAppConfig(parseToml(`[advanced]\ncache_forensics = true\n`));
    expect("err" in staleForensics).toBe(true);
    expect((staleForensics as { err: string }).err).toContain("unknown field `cache_forensics`");

    const moved = parseAppConfig(parseToml(`[cache]\nkeepalive_max = "6h"\nforensics = true\n`));
    if ("err" in moved) throw new Error(moved.err);
    expect(moved.ok.cache.keepalive_max.asSecs()).toBe(21_600n);
    expect(moved.ok.cache.forensics).toBe(true);
  });

  test("[behavior.autonomy] lost a positional slot when the ceiling moved out", () => {
    const tooLong = parseAppConfig(
      parseToml(`[behavior]\nautonomy = [true, { enabled = false }, "6h"]\n`),
    );
    expect("err" in tooLong).toBe(true);
    expect((tooLong as { err: string }).err).toBe(
      "invalid length 3, expected fewer elements in array",
    );

    const nowFull = parseAppConfig(parseToml(`[behavior]\nautonomy = [true, { enabled = false }]\n`));
    if ("err" in nowFull) throw new Error(nowFull.err);
    expect(nowFull.ok.behavior.autonomy.enabled).toBe(true);
    expect(nowFull.ok.behavior.autonomy.heartbeat.enabled).toBe(false);
  });

  test("[advanced.llm_sidecar] is rejected as a section, not just as a key", () => {
    const parsed = parseAppConfig(
      parseToml(`[advanced.llm_sidecar]\nenabled = false\nsocket_path = "/tmp/s.sock"\n`),
    );
    expect("err" in parsed).toBe(true);
    expect((parsed as { err: string }).err).toContain("unknown field `llm_sidecar`");
  });

  test("the surviving [advanced] keys still parse, positionally and by name", () => {
    const byName = parseAppConfig(
      parseToml(`[advanced]\nmax_retries = 5\nretry_backoff = "250ms"\n`),
    );
    if ("err" in byName) throw new Error(byName.err);
    expect(byName.ok.advanced.max_retries).toBe(5);
    expect(byName.ok.advanced.retry_backoff?.asMillisExact()).toBe(250n);

    const positional = parseAppConfig(parseToml(`advanced = [3, "1s"]\n`));
    if ("err" in positional) throw new Error(positional.err);
    expect(positional.ok.advanced.max_retries).toBe(3);

    const tooLong = parseAppConfig(parseToml(`advanced = [3, "1s", 1, 2]\n`));
    expect("err" in tooLong).toBe(true);
    expect((tooLong as { err: string }).err).toBe(
      "invalid length 4, expected fewer elements in array",
    );

    const tooShort = parseAppConfig(parseToml(`advanced = []\n`));
    expect("err" in tooShort).toBe(true);
    expect((tooShort as { err: string }).err).toBe(
      "invalid length 0, expected struct AdvancedConfig with 2 elements",
    );
  });

  test("a connection shore cannot open is not offered as config", () => {
    for (const name of ["telegram", "discord"]) {
      const reserved = parseAppConfig(parseToml(`[connections.${name}]\n`));
      expect("err" in reserved, `[connections.${name}] still parses`).toBe(true);
    }
  });

  test("the matrix connection the fixture rejects now parses, in its external-only shape", () => {
    const c = fixture.parse.find((x) => x.name === "the removed matrix connection is rejected");
    expect(c).toBeDefined();
    expect(required(c).table_err).toBe("unknown field `matrix`, expected `telegram` or `discord`");

    const parsed = parseAppConfig(parseToml(required(c).toml));
    if ("err" in parsed) throw new Error(`expected a parse, got: ${parsed.err}`);
    expect(parsed.ok.connections.matrix).toEqual({
      enabled: true,
      homeserver: "",
      user_id: "",
      room_id: "",
      mirror_all: true,
    });

    const full = parseAppConfig(
      parseToml(
        "[connections.matrix]\nenabled = true\n" +
          'homeserver = "https://matrix.example.com"\n' +
          'user_id = "@shore:example.com"\n' +
          'room_id = "!abc:example.com"\n' +
          "mirror_all = false\n",
      ),
    );
    if ("err" in full) throw new Error(full.err);
    expect(full.ok.connections.matrix).toEqual({
      enabled: true,
      homeserver: "https://matrix.example.com",
      user_id: "@shore:example.com",
      room_id: "!abc:example.com",
      mirror_all: false,
    });
  });

  test("the embedded homeserver table stays rejected, now as an unknown matrix field", () => {
    const c = fixture.parse.find(
      (x) => x.name === "the removed embedded matrix connection is rejected",
    );
    expect(c).toBeDefined();

    const parsed = parseAppConfig(parseToml(required(c).toml));
    expect("err" in parsed).toBe(true);
    expect((parsed as { err: string }).err).toBe(
      "unknown field `embedded`, expected one of `enabled`, `homeserver`, " +
        "`user_id`, `room_id`, `mirror_all`",
    );

    for (const key of ["trusted_user", "embedded"]) {
      const rejected = parseAppConfig(parseToml(`[connections.matrix]\n${key} = "x"\n`));
      expect("err" in rejected, key).toBe(true);
    }
  });

  test("map-valued sections are built in code point order, not document order", () => {
    const src =
      '[subagents.zed]\ndescription = "z"\nprompt = "p"\n\n' +
      '[subagents."\u{1F3B5}drum"]\ndescription = "d"\nprompt = "p"\n\n' +
      '[subagents."\u{FB00}ute"]\ndescription = "f"\nprompt = "p"\n\n' +
      '[mcp.zebra]\ncommand = "z"\nenv = { ZED = "1", ABLE = "2" }\n\n' +
      '[mcp.alpha]\ncommand = "a"\n\n' +
      "[tools.config.zoom]\nmax_result_chars = 1\n\n" +
      "[tools.config.abacus]\nmax_result_chars = 2\n";
    const parsed = parseAppConfig(parseToml(src));
    if ("err" in parsed) throw new Error(parsed.err);

    expect(Object.fromEntries(mapOrderOf(parsed.ok))).toEqual({
      subagents: ["zed", "\u{FB00}ute", "\u{1F3B5}drum"],
      mcp: ["alpha", "zebra"],
      "tools.config": ["abacus", "zoom"],
      "mcp.alpha.env": [],
      "mcp.zebra.env": ["ABLE", "ZED"],
    });
  });
});

describe("the two parse paths, where they disagree", () => {
  const caseNamed = (name: string): { toml: string; doc_err: string; table_err: string } => {
    const found = fixture.parse.find((c) => c.name === name);
    if (found === undefined) throw new Error(`fixture case missing: ${name}`);
    if (!("doc_err" in found) || !("table_err" in found)) {
      throw new Error(`fixture case is not a two-column error: ${name}`);
    }
    return found as { toml: string; doc_err: string; table_err: string };
  };

  test("two unknown keys: the code-point-smallest is reported, not the first written", () => {
    const c = caseNamed(
      "two unknown top-level keys: the document reports the first written, " +
        "the table reports the code-point-smallest",
    );
    const parsed = parseAppConfig(parseToml(c.toml));
    if ("ok" in parsed) throw new Error("expected a parse error");
    expect(parsed.err).toContain("`aaa_unknown`");
    expect(parsed.err).not.toContain("`zzz_unknown`");
    expect(withRustFieldCounts(parsed.err)).toBe(c.table_err);
    expect(withRustFieldCounts(parsed.err)).not.toBe(c.doc_err);
  });

  test("a bad type sorting before an unknown key wins the race", () => {
    const c = caseNamed("an unknown key and a bad type: which is reported depends on the path");
    const parsed = parseAppConfig(parseToml(c.toml));
    if ("ok" in parsed) throw new Error("expected a parse error");
    expect(parsed.err).toBe('invalid type: string "yes", expected a boolean');
    expect(parsed.err).toBe(c.table_err);
    expect(parsed.err).not.toBe(c.doc_err);
  });
});

describe("where Bun's TOML parser and Rust's toml still differ", () => {
  test("a datetime parses, and lands on the error Rust's document path gives", () => {
    const c = fixture.parse.find((x) => x.name === "datetime where a string is expected");
    if (c === undefined) throw new Error("fixture case missing");
    const table = parseToml(c.toml) as { defaults: { model: unknown } };
    expect(Object.prototype.toString.call(table.defaults.model)).toBe("[object Temporal.Instant]");

    const docErr = c.doc?.err;
    if (docErr === undefined) throw new Error("expected a recorded document-path error");
    const parsed = parseAppConfig(parseToml(c.toml));
    expect("err" in parsed ? parsed.err : "").toBe(docErr);

    const recorded = c.table?.ok as { defaults: { model: string } } | undefined;
    if (recorded === undefined) throw new Error("expected a table-path success");
    expect(recorded.defaults.model).toBe("1979-05-27T07:32:00Z");
  });

  for (const name of ["a float that happens to be whole is still a float", "exponent notation is a float too"]) {
    test(`${name} — accepted here, rejected in Rust`, () => {
      const c = fixture.parse.find((x) => x.name === name);
      if (c === undefined) throw new Error("fixture case missing");
      expect(c.table_err).toContain("expected usize");

      const parsed = parseAppConfig(parseToml(c.toml));
      if ("err" in parsed) throw new Error(`expected the looser parse, got: ${parsed.err}`);
      expect(parsed.ok.tools.max_result_chars).toBe(name.startsWith("exponent") ? 1000 : 20000);
    });
  }

  test("a nested array literal parses, so the seq cases replay against the recording", () => {
    expect(parseToml("a = [[1]]")).toEqual({ a: [[1]] });
    for (const name of ["seq: UsageBudgetConfig, at its minimum", "a required field supplied positionally"]) {
      expect(BUN_CANNOT_SEE.has(name)).toBe(false);
    }
  });

  test("the recorded u64 case is refused outright, where Rust took the value", () => {
    const c = fixture.parse.find((x) => x.name === "u64 fields hold values a double cannot");
    if (c === undefined) throw new Error("fixture case missing");
    const rust = c.ok as { advanced: Record<string, unknown> } | undefined;
    if (rust === undefined) throw new Error("expected a recorded success");
    expect(rust.advanced.max_image_size).toBe(9007199254740992);

    expect(() => parseToml(c.toml)).toThrow("losslessly");

    const parsed = parseAppConfig(parseToml("[advanced]\nmax_image_size = 1\n"));
    expect("err" in parsed ? parsed.err : "").toBe(
      "unknown field `max_image_size`, expected `max_retries` or `retry_backoff`",
    );
  });

  test("a u64 past 2^53 fails the whole document instead of losing its last digit", () => {
    expect(() => parseToml(`[memory.retrieval]\nmax_file_bytes = 9007199254740993\n`)).toThrow(
      "losslessly",
    );

    const parsed = parseAppConfig(
      parseToml(`[memory.retrieval]\nmax_file_bytes = 9007199254740991\n`),
    );
    if ("err" in parsed) throw new Error(parsed.err);
    expect(parsed.ok.memory.retrieval.max_file_bytes).toBe(9007199254740991);
  });
});

describe("the tool allowlist and per-tool resolution", () => {
  const recorded = fixture.defaults.tools as { max_result_chars: number; timeout: string };
  const recordedTimeoutMs = Number(
    (ConfigDuration.deserialize(recorded.timeout) as { ok: ConfigDuration }).ok.asMillisExact(),
  );

  const current = defaultToolsConfig();
  const currentTimeoutMs = Number(current.timeout?.asMillisExact() ?? Number.NaN);

  const inherited = (
    set: ReadonlySet<string>,
    tool: string,
    field: string,
    recordedValue: number,
    recordedDefault: number,
    currentDefault: number,
  ) => {
    const pinned =
      set.has(`tools.${field}`) || set.has(`tools.config.${tool}.${field}`);
    return !pinned && recordedValue === recordedDefault ? currentDefault : recordedValue;
  };

  for (const c of fixture.tools_queries) {
    test(c.name, () => {
      const set = pathsSetBy(parseToml(c.toml));
      const parsed = parseAppConfig(parseToml(c.toml));
      if ("err" in parsed) throw new Error(parsed.err);
      const tools: ToolsConfig = parsed.ok.tools;

      expect(anyToolEnabled(tools)).toBe(c.any_enabled);

      for (const t of c.tools) {
        expect({
          name: t.name,
          enabled: toolEnabled(tools, t.name),
          result_chars: resultCharsFor(tools, t.name),
          timeout_ms: Number(timeoutFor(tools, t.name)?.asMillisExact() ?? Number.NaN),
        }).toEqual({
          name: t.name,
          enabled: t.enabled,
          result_chars: inherited(
            set,
            t.name,
            "max_result_chars",
            t.result_chars,
            recorded.max_result_chars,
            current.max_result_chars,
          ),
          timeout_ms:
            t.timeout_ms === undefined || t.timeout_ms === null
              ? Number.NaN
              : inherited(set, t.name, "timeout", t.timeout_ms, recordedTimeoutMs, currentTimeoutMs),
        });
      }

      for (const s of c.subagents) {
        expect(subagentEnabled(tools, s.name)).toBe(s.enabled);
      }
    });
  }

  test("no deadline is `undefined`, not a zero duration", () => {
    const parsed = parseAppConfig(parseToml("[tools]\ntimeout = 0\n"));
    if ("err" in parsed) throw new Error(parsed.err);
    expect(timeoutFor(parsed.ok.tools, "read")).toBeUndefined();
  });
});

describe("sub-agent timeouts", () => {
  test("a sub-agent timeout parses as a duration", () => {
    const parsed = parseAppConfig(
      parseToml('[subagents.research]\ndescription = "d"\nprompt = "p"\ntimeout = "20m"\n'),
    );
    if ("err" in parsed) throw new Error(parsed.err);
    expect(parsed.ok.subagents.get("research")?.timeout?.asMillis()).toBe(1_200_000);
  });

  test("a sub-agent without a timeout leaves it unset", () => {
    const parsed = parseAppConfig(
      parseToml('[subagents.research]\ndescription = "d"\nprompt = "p"\n'),
    );
    if ("err" in parsed) throw new Error(parsed.err);
    expect(parsed.ok.subagents.get("research")?.timeout).toBeUndefined();
  });
});

describe("tool_pattern_matches", () => {
  for (const c of fixture.tool_patterns) {
    test(`${JSON.stringify(c.pattern)} vs ${JSON.stringify(c.name)}`, () => {
      expect(toolPatternMatches(c.pattern, c.name)).toBe(c.matches);
    });
  }

  test("the cases cover both branches and both answers", () => {
    const globs = fixture.tool_patterns.filter((c) => c.pattern.endsWith("*"));
    const exact = fixture.tool_patterns.filter((c) => !c.pattern.endsWith("*"));
    expect(globs.some((c) => c.matches)).toBe(true);
    expect(globs.some((c) => !c.matches)).toBe(true);
    expect(exact.some((c) => c.matches)).toBe(true);
    expect(exact.some((c) => !c.matches)).toBe(true);
  });
});

function defaultsFromJson(json: {
  model: string | null;
  background: { model: string | null; heartbeat: string | null; compaction: string | null };
  embedding: string | null;
  image_generation: string | null;
  subagent_model: string | null;
  display_name: string | null;
  stream: boolean;
}): DefaultsConfig {
  const or = (v: string | null) => v ?? undefined;
  return {
    model: or(json.model),
    background: {
      model: or(json.background.model),
      heartbeat: or(json.background.heartbeat),
      compaction: or(json.background.compaction),
    },
    embedding: or(json.embedding),
    image_generation: or(json.image_generation),
    subagent_model: or(json.subagent_model),
    display_name: or(json.display_name),
    stream: json.stream,
  };
}

describe("background model resolution", () => {
  for (const c of fixture.background) {
    test(c.name, () => {
      const defaults = defaultsFromJson(c.defaults);
      for (const [task, want] of [
        ["heartbeat", c.heartbeat],
        ["compaction", c.compaction],
      ] as [BackgroundTask, string | null][]) {
        expect(resolveBackgroundModelName(defaults, task) ?? null).toBe(want);
      }
    });
  }
});

describe("removed config keys", () => {
  for (const c of fixture.removed_keys) {
    test(c.name, () => {
      const parsed = parseAppConfig(parseToml(c.toml));
      expect("err" in parsed ? parsed.err : null).toBe(c.err);
    });
  }

  test("the message names the key that replaced it, not just the valid fields", () => {
    const refused = fixture.removed_keys.filter((c) => c.err !== null);
    expect(refused.length).toBeGreaterThan(0);
    for (const c of refused) {
      expect(c.err).toContain("was removed");
      expect(c.err).toContain("[defaults.background]");
      expect(c.err).not.toContain("unknown field");
    }
  });
});

describe("resolve_display_name", () => {
  for (const c of fixture.display_name) {
    test(c.name, () => {
      const defaults = {
        ...defaultAppConfig().defaults,
        display_name: c.display_name ?? undefined,
      };
      const env = c.user_env === null ? {} : { USER: c.user_env };
      expect(resolveDisplayName(defaults, env)).toBe(c.resolved);
    });
  }
});

describe("compaction validation", () => {
  for (const c of fixture.compaction_validate) {
    test(c.name, () => {
      const compaction = {
        enabled: c.compaction.enabled,
        idle_trigger: durationFrom(c.compaction.idle_trigger),
        archive_after: durationFrom(c.compaction.archive_after),
        min_turns: c.compaction.min_turns,
        max_turns: c.compaction.max_turns,
        max_context_tokens: c.compaction.max_context_tokens,
        keep_recent_turns: c.compaction.keep_recent_turns,
      };
      expect(validateCompaction(compaction) ?? null).toBe(c.err);
    });
  }

  test("the rejection names the two values that would work", () => {
    const c = fixture.compaction_validate.find((x) =>
      x.name.includes("names the two values"),
    );
    if (c === undefined || c.err === null) throw new Error("fixture case missing");
    expect(c.err).toContain("`90s`");
    expect(c.err).toContain("`91s`");
  });
});

function durationFrom(display: string): ConfigDuration {
  const parsed = ConfigDuration.parse(display);
  if ("err" in parsed) throw new Error(`${display}: ${parsed.err}`);
  return parsed.ok;
}

describe("budget pace fallbacks", () => {
  for (const c of fixture.budget_pace) {
    test(c.name, () => {
      const parsed = parseAppConfig(parseToml(c.toml));
      if ("err" in parsed) throw new Error(parsed.err);

      expect(
        parsed.ok.usage.budgets.map((b) => ({
          pace_action: budgetPaceAction(b) as string,
          pace_warn_at: [...budgetPaceWarnAt(b)],
        })),
      ).toEqual(c.budgets);
    });
  }
});

describe("budget enum tables", () => {
  test("period ranks", () => {
    expect(
      fixture.budget_periods.map((p) => ({
        period: p.period,
        rank: budgetPeriodRank(p.period as UsageBudgetPeriod),
      })),
    ).toEqual(fixture.budget_periods);
  });

  test("weekday offsets", () => {
    expect(
      fixture.budget_weekdays.map((d) => ({
        weekday: d.weekday,
        num_days_from_monday: numDaysFromMonday(d.weekday as BudgetWeekday),
      })),
    ).toEqual(fixture.budget_weekdays);
  });

  test("every action variant round-trips through the schema", () => {
    for (const action of fixture.budget_actions) {
      const parsed = parseAppConfig(
        parseToml(`[[usage.budgets]]\ncost_usd = 1.0\nlimit = ${JSON.stringify(action)}\n`),
      );
      if ("err" in parsed) throw new Error(parsed.err);
      expect(parsed.ok.usage.budgets[0]?.limit as string | undefined).toBe(action);
    }
  });
});

describe("parse_wire for replay_prior_thinking", () => {
  for (const c of fixture.thinking_replay) {
    test(JSON.stringify(c.input), () => {
      expect((parseThinkingReplay(c.input) ?? null) as string | null).toBe(c.parsed);
    });
  }

  test("the retired last_turn mode is accepted, not rejected", () => {
    expect(parseThinkingReplay("last_turn")).toBe("all");
  });
});

describe("mapKeysInOrder", () => {
  test("sorts by code point, not UTF-16 code unit", () => {
    const m = new Map([
      ["\u{1F3B5}drum", 1],
      ["\u{FB00}ute", 2],
      ["zed", 3],
    ]);
    expect(mapKeysInOrder(m)).toEqual(["zed", "\u{FB00}ute", "\u{1F3B5}drum"]);
  });
});
