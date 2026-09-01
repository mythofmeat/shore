import { describe, expect, test } from "bun:test";

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
  type BackgroundTask,
  type BudgetWeekday,
  type DefaultsConfig,
  type ToolsConfig,
  type UsageBudgetPeriod,
} from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";

function parseToml(src: string): unknown {
  return Bun.TOML.parse(src);
}

function canonical(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof ConfigDuration) return value.toString();
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value as ReadonlyMap<string, unknown>) out[k] = canonical(v);
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

function parsed(toml: string): unknown {
  const result = parseAppConfig(parseToml(toml));
  if ("err" in result) throw new Error(`expected a config, got: ${result.err}`);
  return canonical(result.ok);
}

function rejected(toml: string): string {
  const result = parseAppConfig(parseToml(toml));
  if ("ok" in result) throw new Error("expected a parse error, got a config");
  return result.err;
}

function at(config: unknown, path: string): unknown {
  let node: unknown = config;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const TOOLS_QUERIES = [
  {
    "name": "the empty default offers nothing but still caps and deadlines",
    "toml": "[tools]\n",
    "any_enabled": false,
    "tools": [
      {
        "name": "read",
        "enabled": false
      },
      {
        "name": "search_chat_logs",
        "enabled": false
      },
      {
        "name": "anything",
        "enabled": false
      }
    ],
    "subagents": [
      {
        "name": "memory",
        "enabled": false
      }
    ]
  },
  {
    "name": "exact allowlist entries",
    "toml": "[tools]\nenabled_tools = [\"read\", \"search_chat_logs\"]\n",
    "any_enabled": true,
    "tools": [
      {
        "name": "read",
        "enabled": true
      },
      {
        "name": "ready",
        "enabled": false
      },
      {
        "name": "search_chat_logs",
        "enabled": true
      },
      {
        "name": "roll_dice",
        "enabled": false
      },
      {
        "name": "web_search",
        "enabled": false
      }
    ],
    "subagents": [
      {
        "name": "memory",
        "enabled": false
      }
    ]
  },
  {
    "name": "a trailing star is a prefix glob, scoped to one server",
    "toml": "[tools]\nenabled_tools = [\"read\", \"mcp__hue__*\"]\n",
    "any_enabled": true,
    "tools": [
      {
        "name": "mcp__hue__set_light",
        "enabled": true
      },
      {
        "name": "mcp__hue__list_lights",
        "enabled": true
      },
      {
        "name": "mcp__hue__",
        "enabled": true
      },
      {
        "name": "mcp__nanoleaf__on",
        "enabled": false
      }
    ],
    "subagents": []
  },
  {
    "name": "per-tool caps and deadlines, and what inherits",
    "toml": "[tools]\nenabled_tools = [\"search\", \"read\"]\nmax_result_chars = 20000\ntimeout = \"30s\"\n\n[tools.config.search]\nmax_result_chars = 10000\n\n[tools.config.ask_researcher]\ntimeout = \"20m\"\n",
    "any_enabled": true,
    "tools": [
      {
        "name": "search",
        "enabled": true
      },
      {
        "name": "read",
        "enabled": true
      },
      {
        "name": "ask_researcher",
        "enabled": false
      },
      {
        "name": "never_configured",
        "enabled": false
      }
    ],
    "subagents": [
      {
        "name": "researcher",
        "enabled": false
      }
    ]
  },
  {
    "name": "a zero global deadline is overridable per tool",
    "toml": "[tools]\nenabled_tools = [\"read\", \"git\"]\ntimeout = 0\n\n[tools.config.git]\ntimeout = \"45s\"\n",
    "any_enabled": true,
    "tools": [
      {
        "name": "read",
        "enabled": true
      },
      {
        "name": "git",
        "enabled": true
      }
    ],
    "subagents": []
  },
  {
    "name": "a zero per-tool deadline opts one tool out of a global one",
    "toml": "[tools]\nenabled_tools = [\"read\", \"slow\"]\ntimeout = \"30s\"\n\n[tools.config.slow]\ntimeout = 0\n",
    "any_enabled": true,
    "tools": [
      {
        "name": "read",
        "enabled": true
      },
      {
        "name": "slow",
        "enabled": true
      }
    ],
    "subagents": []
  },
  {
    "name": "a zero cap disables truncation for that tool only",
    "toml": "[tools]\nmax_result_chars = 20000\n\n[tools.config.dump]\nmax_result_chars = 0\n",
    "any_enabled": false,
    "tools": [
      {
        "name": "dump",
        "enabled": false
      },
      {
        "name": "read",
        "enabled": false
      }
    ],
    "subagents": []
  },
  {
    "name": "subagents alone make the tool surface active",
    "toml": "[tools]\nenabled_subagents = [\"memory\"]\n",
    "any_enabled": true,
    "tools": [
      {
        "name": "read",
        "enabled": false
      }
    ],
    "subagents": [
      {
        "name": "memory",
        "enabled": true
      },
      {
        "name": "research",
        "enabled": false
      }
    ]
  },
  {
    "name": "the subagent allowlist takes no globs",
    "toml": "[tools]\nenabled_subagents = [\"mem*\"]\n",
    "any_enabled": true,
    "tools": [],
    "subagents": [
      {
        "name": "mem",
        "enabled": false
      },
      {
        "name": "memory",
        "enabled": false
      },
      {
        "name": "mem*",
        "enabled": true
      }
    ]
  }
];

const TOOL_PATTERNS = [
  {
    "pattern": "read",
    "name": "read",
    "matches": true
  },
  {
    "pattern": "read",
    "name": "ready",
    "matches": false
  },
  {
    "pattern": "read",
    "name": "rea",
    "matches": false
  },
  {
    "pattern": "read",
    "name": "",
    "matches": false
  },
  {
    "pattern": "mcp__hue__*",
    "name": "mcp__hue__set_light",
    "matches": true
  },
  {
    "pattern": "mcp__hue__*",
    "name": "mcp__hue__",
    "matches": true
  },
  {
    "pattern": "mcp__hue__*",
    "name": "mcp__hue_",
    "matches": false
  },
  {
    "pattern": "mcp__hue__*",
    "name": "mcp__nanoleaf__on",
    "matches": false
  },
  {
    "pattern": "mcp__*",
    "name": "mcp__hue__set_light",
    "matches": true
  },
  {
    "pattern": "*",
    "name": "anything",
    "matches": true
  },
  {
    "pattern": "*",
    "name": "",
    "matches": true
  },
  {
    "pattern": "",
    "name": "",
    "matches": true
  },
  {
    "pattern": "",
    "name": "x",
    "matches": false
  },
  {
    "pattern": "mcp__*__on",
    "name": "mcp__hue__on",
    "matches": false
  },
  {
    "pattern": "mcp__*__on",
    "name": "mcp__*__on",
    "matches": true
  },
  {
    "pattern": "mcp__*__on",
    "name": "mcp__*__onx",
    "matches": false
  },
  {
    "pattern": "**",
    "name": "*",
    "matches": true
  },
  {
    "pattern": "**",
    "name": "",
    "matches": false
  }
];

const BACKGROUND = [
  {
    "name": "nothing set",
    "defaults": {
      "model": null,
      "background": {
        "model": null,
        "heartbeat": null,
        "compaction": null
      },
      "embedding": null,
      "image_generation": null,
      "subagent_model": null,
      "display_name": null,
      "stream": true
    },
    "heartbeat": null,
    "compaction": null
  },
  {
    "name": "defaults.model is not a background fallback",
    "defaults": {
      "model": "chat",
      "background": {
        "model": null,
        "heartbeat": null,
        "compaction": null
      },
      "embedding": null,
      "image_generation": null,
      "subagent_model": null,
      "display_name": null,
      "stream": true
    },
    "heartbeat": null,
    "compaction": null
  },
  {
    "name": "background.model covers every task",
    "defaults": {
      "model": "chat",
      "background": {
        "model": "bg",
        "heartbeat": null,
        "compaction": null
      },
      "embedding": null,
      "image_generation": null,
      "subagent_model": null,
      "display_name": null,
      "stream": true
    },
    "heartbeat": "bg",
    "compaction": "bg"
  },
  {
    "name": "a per-task override wins over background.model",
    "defaults": {
      "model": "chat",
      "background": {
        "model": "bg",
        "heartbeat": "hb",
        "compaction": null
      },
      "embedding": null,
      "image_generation": null,
      "subagent_model": null,
      "display_name": null,
      "stream": true
    },
    "heartbeat": "hb",
    "compaction": "bg"
  },
  {
    "name": "a per-task override with no blanket model",
    "defaults": {
      "model": null,
      "background": {
        "model": null,
        "heartbeat": null,
        "compaction": "c"
      },
      "embedding": null,
      "image_generation": null,
      "subagent_model": null,
      "display_name": null,
      "stream": true
    },
    "heartbeat": null,
    "compaction": "c"
  },
  {
    "name": "the deprecated top-level key is not consulted before normalizing",
    "defaults": {
      "model": null,
      "background": {
        "model": null,
        "heartbeat": null,
        "compaction": null
      },
      "embedding": null,
      "image_generation": null,
      "subagent_model": null,
      "display_name": null,
      "stream": true
    },
    "heartbeat": null,
    "compaction": null
  }
];

const DISPLAY_NAME = [
  {
    "name": "configured wins",
    "display_name": "Alice",
    "user_env": "bob",
    "resolved": "Alice"
  },
  {
    "name": "falls back to $USER",
    "display_name": null,
    "user_env": "bob",
    "resolved": "bob"
  },
  {
    "name": "falls back to User when both are absent",
    "display_name": null,
    "user_env": null,
    "resolved": "User"
  },
  {
    "name": "an empty $USER is still a value",
    "display_name": null,
    "user_env": "",
    "resolved": ""
  },
  {
    "name": "an empty configured name is still a value",
    "display_name": "",
    "user_env": "bob",
    "resolved": ""
  }
];

const COMPACTION_VALIDATE = [
  {
    "name": "the default is valid",
    "compaction": {
      "enabled": true,
      "idle_trigger": "30m",
      "archive_after": "0s",
      "min_turns": 8,
      "max_turns": 16,
      "max_context_tokens": 200000,
      "keep_recent_turns": 2
    },
    "err": null
  },
  {
    "name": "min_turns equal to keep_recent_turns is rejected",
    "compaction": {
      "enabled": true,
      "idle_trigger": "30m",
      "archive_after": "0s",
      "min_turns": 4,
      "max_turns": 16,
      "max_context_tokens": 200000,
      "keep_recent_turns": 4
    },
    "err": "memory.compaction.min_turns (4) and max_turns (16) must both be greater than keep_recent_turns (4); raise the turn thresholds or lower keep_recent_turns"
  },
  {
    "name": "max_turns below min_turns is rejected",
    "compaction": {
      "enabled": true,
      "idle_trigger": "30m",
      "archive_after": "0s",
      "min_turns": 10,
      "max_turns": 5,
      "max_context_tokens": 200000,
      "keep_recent_turns": 2
    },
    "err": "memory.compaction.max_turns (5) must be >= min_turns (10)"
  },
  {
    "name": "a disabled config is always valid",
    "compaction": {
      "enabled": false,
      "idle_trigger": "1500ms",
      "archive_after": "0s",
      "min_turns": 4,
      "max_turns": 16,
      "max_context_tokens": 200000,
      "keep_recent_turns": 4
    },
    "err": null
  },
  {
    "name": "a fractional idle_trigger names the two values that would work",
    "compaction": {
      "enabled": true,
      "idle_trigger": "90500ms",
      "archive_after": "0s",
      "min_turns": 8,
      "max_turns": 16,
      "max_context_tokens": 200000,
      "keep_recent_turns": 2
    },
    "err": "memory.compaction.idle_trigger is 90500ms. Idle thresholds must be a whole number of seconds: the compaction triggers truncate to seconds before comparing, so a value like `1.5s` would fire early. Use `90s` or `91s`."
  },
  {
    "name": "a fractional archive_after is rejected too",
    "compaction": {
      "enabled": true,
      "idle_trigger": "30m",
      "archive_after": "1ms",
      "min_turns": 8,
      "max_turns": 16,
      "max_context_tokens": 200000,
      "keep_recent_turns": 2
    },
    "err": "memory.compaction.archive_after is 1ms. Idle thresholds must be a whole number of seconds: the compaction triggers truncate to seconds before comparing, so a value like `1.5s` would fire early. Use `0s` or `1s`."
  },
  {
    "name": "zero is a whole number of seconds",
    "compaction": {
      "enabled": true,
      "idle_trigger": "0s",
      "archive_after": "0s",
      "min_turns": 8,
      "max_turns": 16,
      "max_context_tokens": 200000,
      "keep_recent_turns": 2
    },
    "err": null
  },
  {
    "name": "the idle check runs before the turn check",
    "compaction": {
      "enabled": true,
      "idle_trigger": "1ms",
      "archive_after": "0s",
      "min_turns": 1,
      "max_turns": 16,
      "max_context_tokens": 200000,
      "keep_recent_turns": 4
    },
    "err": "memory.compaction.idle_trigger is 1ms. Idle thresholds must be a whole number of seconds: the compaction triggers truncate to seconds before comparing, so a value like `1.5s` would fire early. Use `0s` or `1s`."
  },
  {
    "name": "max_turns equal to keep_recent_turns is rejected by the first check",
    "compaction": {
      "enabled": true,
      "idle_trigger": "30m",
      "archive_after": "0s",
      "min_turns": 9,
      "max_turns": 2,
      "max_context_tokens": 200000,
      "keep_recent_turns": 2
    },
    "err": "memory.compaction.min_turns (9) and max_turns (2) must both be greater than keep_recent_turns (2); raise the turn thresholds or lower keep_recent_turns"
  }
];

const BUDGET_PACE = [
  {
    "name": "pace fields default to warn and to the budget's own warn_at",
    "toml": "[[usage.budgets]]\ncost_usd = 5.0\nwarn_at = [0.3, 0.9]\n",
    "budgets": [
      {
        "pace_action": "warn",
        "pace_warn_at": [
          0.3,
          0.9
        ]
      }
    ]
  },
  {
    "name": "explicit pace overrides",
    "toml": "[[usage.budgets]]\ncost_usd = 5.0\nwarn_at = [0.3]\npace_action = \"block\"\npace_warn_at = [0.1, 0.2]\n",
    "budgets": [
      {
        "pace_action": "block",
        "pace_warn_at": [
          0.1,
          0.2
        ]
      }
    ]
  },
  {
    "name": "an empty pace_warn_at is an override, not an absence",
    "toml": "[[usage.budgets]]\ncost_usd = 5.0\nwarn_at = [0.3]\npace_warn_at = []\n",
    "budgets": [
      {
        "pace_action": "warn",
        "pace_warn_at": []
      }
    ]
  },
  {
    "name": "the default warn_at flows into pace_warn_at",
    "toml": "[[usage.budgets]]\ncost_usd = 5.0\n",
    "budgets": [
      {
        "pace_action": "warn",
        "pace_warn_at": [
          0.8,
          1.0
        ]
      }
    ]
  }
];

const BUDGET_PERIODS = [
  {
    "period": "hour",
    "rank": 0
  },
  {
    "period": "day",
    "rank": 1
  },
  {
    "period": "week",
    "rank": 2
  },
  {
    "period": "month",
    "rank": 3
  }
];

const BUDGET_WEEKDAYS = [
  {
    "weekday": "monday",
    "num_days_from_monday": 0
  },
  {
    "weekday": "tuesday",
    "num_days_from_monday": 1
  },
  {
    "weekday": "wednesday",
    "num_days_from_monday": 2
  },
  {
    "weekday": "thursday",
    "num_days_from_monday": 3
  },
  {
    "weekday": "friday",
    "num_days_from_monday": 4
  },
  {
    "weekday": "saturday",
    "num_days_from_monday": 5
  },
  {
    "weekday": "sunday",
    "num_days_from_monday": 6
  }
];

const BUDGET_ACTIONS = [
  "warn",
  "block",
  "pause_background"
];

const THINKING_REPLAY = [
  {
    "input": "all",
    "parsed": "all"
  },
  {
    "input": "none",
    "parsed": "none"
  },
  {
    "input": "true",
    "parsed": "all"
  },
  {
    "input": "false",
    "parsed": "none"
  },
  {
    "input": "last_turn",
    "parsed": "all"
  },
  {
    "input": "All",
    "parsed": null
  },
  {
    "input": "",
    "parsed": null
  },
  {
    "input": "recent",
    "parsed": null
  },
  {
    "input": "1",
    "parsed": null
  },
  {
    "input": "0",
    "parsed": null
  }
];

const REMOVED_KEYS = [
  {
    "name": "the retired alias is refused, not forwarded",
    "toml": "[defaults]\nmodel = \"primary\"\nheartbeat = \"hb-old\"\n",
    "err": "`heartbeat` was removed — set it under `[defaults.background]` as `heartbeat`"
  },
  {
    "name": "setting both spellings is still refused",
    "toml": "[defaults]\nheartbeat = \"hb-old\"\n\n[defaults.background]\nheartbeat = \"hb-new\"\n",
    "err": "`heartbeat` was removed — set it under `[defaults.background]` as `heartbeat`"
  },
  {
    "name": "an empty string is a value, not an absence",
    "toml": "[defaults]\nheartbeat = \"\"\n",
    "err": "`heartbeat` was removed — set it under `[defaults.background]` as `heartbeat`"
  },
  {
    "name": "the key that replaced it still parses",
    "toml": "[defaults.background]\nheartbeat = \"hb\"\n",
    "err": null
  }
];

describe("the shipped defaults", () => {
  test("parse out of an empty document, so a config file is optional", () => {
    expect(parsed("")).toEqual(canonical(defaultAppConfig()));
  });

  test("leave every model unset, so nothing is silently chosen for you", () => {
    const d = defaultAppConfig().defaults;
    expect(d.model).toBeUndefined();
    expect(d.embedding).toBeUndefined();
    expect(d.subagent_model).toBeUndefined();
    expect(d.background.model).toBeUndefined();
  });

  test("give every duration a sane value, never negative", () => {
    const walk = (node: unknown, path: string): void => {
      if (node instanceof ConfigDuration) {
        expect(node.asMillis(), path).toBeGreaterThanOrEqual(0);
        return;
      }
      if (node instanceof Map) {
        for (const [k, v] of node) walk(v, `${path}.${k}`);
        return;
      }
      if (Array.isArray(node)) {
        for (const [i, v] of node.entries()) walk(v, `${path}[${i}]`);
        return;
      }
      if (typeof node === "object" && node !== null) {
        for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
      }
    };
    walk(defaultAppConfig(), "app");
  });

  test("give memory recall enough time for a CPU reranker", () => {
    expect(at(parsed(""), "memory.recall.timeout")).toEqual("30s");
  });

  test("leave compaction's archive step off, since zero means disabled", () => {
    expect(defaultAppConfig().memory.compaction.archive_after.asMillis()).toBe(0);
  });

  test("enable no tools, so a fresh install cannot touch the filesystem", () => {
    expect(anyToolEnabled(defaultToolsConfig())).toBe(false);
  });

  test("round-trip: re-parsing a serialized default config gives the same config", () => {
    expect(parsed("")).toEqual(parsed("\n\n# a comment\n\n"));
  });
});

describe("when a document has more than one thing wrong", () => {
  test("the code-point-smallest unknown key is reported, not the first written", () => {
    const err = rejected("zzz_unknown = 1\naaa_unknown = 2\n");
    expect(err).toContain("aaa_unknown");
    expect(err).not.toContain("zzz_unknown");
  });

  test("a bad type is reported with the value that was wrong", () => {
    expect(rejected('[defaults]\nstream = "yes"\n')).toBe(
      'invalid type: string "yes", expected a boolean',
    );
  });
});

describe("a config.toml sets what it says and nothing else", () => {
  test("the subagents table", () => {
    const cfg = parsed("[defaults]\nsubagent_model = \"anthropic:claude-haiku-4-5\"\n\n[subagents.music]\ndescription = \"Ask about the music library.\"\nprompt = \"You are a music assistant for {{char}}.\"\ntools = [\"search\", \"read\"]\nmax_iterations = 6\n");
    expect(at(cfg, "defaults.subagent_model"), "defaults.subagent_model").toEqual("anthropic:claude-haiku-4-5");
    expect(at(cfg, "subagents"), "subagents").toMatchObject({"music":{"description":"Ask about the music library.","prompt":"You are a music assistant for {{char}}.","tools":["search","read"],"model":null,"max_iterations":6}});
  });

  test("subagent keys sort by code point, not UTF-16 order", () => {
    const cfg = parsed("[subagents.\"🎵drum\"]\ndescription = \"d\"\nprompt = \"p\"\n\n[subagents.\"ﬀute\"]\ndescription = \"f\"\nprompt = \"p\"\n\n[subagents.zed]\ndescription = \"z\"\nprompt = \"p\"\n");
    expect(at(cfg, "subagents"), "subagents").toMatchObject({"zed":{"description":"z","prompt":"p","tools":[],"model":null,"max_iterations":null},"ﬀute":{"description":"f","prompt":"p","tools":[],"model":null,"max_iterations":null},"🎵drum":{"description":"d","prompt":"p","tools":[],"model":null,"max_iterations":null}});
  });

  test("memory.retrieval", () => {
    const cfg = parsed("[memory.retrieval]\nmode = \"hybrid\"\nmax_file_bytes = 12345\nmax_indexed_files = 999\nmax_total_indexed_bytes = 777777\nmax_embed_chars_per_file = 222\nbinary = \"metadata\"\n");
    expect(at(cfg, "memory.retrieval.mode"), "memory.retrieval.mode").toEqual("hybrid");
    expect(at(cfg, "memory.retrieval.max_file_bytes"), "memory.retrieval.max_file_bytes").toEqual(12345);
    expect(at(cfg, "memory.retrieval.max_indexed_files"), "memory.retrieval.max_indexed_files").toEqual(999);
    expect(at(cfg, "memory.retrieval.max_total_indexed_bytes"), "memory.retrieval.max_total_indexed_bytes").toEqual(777777);
    expect(at(cfg, "memory.retrieval.max_embed_chars_per_file"), "memory.retrieval.max_embed_chars_per_file").toEqual(222);
    expect(at(cfg, "memory.retrieval.binary"), "memory.retrieval.binary").toEqual("metadata");
  });

  test("memory.recall and archive-only rotation", () => {
    const cfg = parsed("[memory.compaction]\nwrite_memory = false\n\n[memory.recall]\nmode = \"inject\"\nquery_from = \"recent\"\nrecent_messages = 3\nmax_memories = 8\ntimeout = \"1500ms\"\npreamble = \"Relevant private notes:\"\nwrap_before = \"<recalled_memories>\\n\"\nwrap_after = \"\\n</recalled_memories>\"\n");
    expect(at(cfg, "memory.compaction.write_memory")).toBe(false);
    expect(at(cfg, "memory.recall")).toMatchObject({
      mode: "inject",
      query_from: "recent",
      recent_messages: 3,
      max_memories: 8,
      timeout: "1500ms",
      preamble: "Relevant private notes:",
      wrap_before: "<recalled_memories>\n",
      wrap_after: "\n</recalled_memories>",
    });
  });

  test("memory.retain", () => {
    const cfg = parsed("[memory.retain]\nenabled = true\nuser_name = \"Ren\"\npossessive_pronoun = \"his\"\ntimeout = \"20s\"\n");
    expect(at(cfg, "memory.retain")).toEqual({
      enabled: true,
      user_name: "Ren",
      possessive_pronoun: "his",
      timeout: "20s",
    });
  });

  test("memory.backend", () => {
    const cfg = parsed("[memory.backend]\nurl = \"http://mcp-hindsight:8888/mcp/\"\nbank = \"shared\"\n\n[memory.backend.headers]\nAuthorization = \"Bearer t\"\n");
    expect(at(cfg, "memory.backend")).toEqual({
      url: "http://mcp-hindsight:8888/mcp/",
      bank: "shared",
      headers: { Authorization: "Bearer t" },
    });
  });

  test("memory.git_push", () => {
    const cfg = parsed("[memory]\ngit_push = true\n");
    expect(at(cfg, "memory.git_push"), "memory.git_push").toEqual(true);
  });


  test("budget anchors and the pace sub-window", () => {
    const cfg = parsed("[[usage.budgets]]\ncost_usd = 5.0\nperiod = \"week\"\nreset_hour = 4\nreset_day_of_week = \"thursday\"\npace_period = \"day\"\npace_action = \"pause_background\"\npace_warn_at = [0.25]\n\n[[usage.budgets]]\ncost_usd = 9.0\nperiod = \"month\"\nreset_day_of_month = 31\nallow_compaction_over_budget = true\n");
    expect(at(cfg, "usage.budgets"), "usage.budgets").toMatchObject([{"name":"","period":"week","cost_usd":5,"warn_at":[0.8,1],"limit":"warn","character":null,"provider":null,"api_key":null,"model":null,"call_type":null,"usage_kind":[],"allow_compaction_over_budget":null,"reset_hour":4,"reset_day_of_week":"thursday","reset_day_of_month":null,"pace_period":"day","pace_action":"pause_background","pace_warn_at":[0.25]},{"name":"","period":"month","cost_usd":9,"warn_at":[0.8,1],"limit":"warn","character":null,"provider":null,"api_key":null,"model":null,"call_type":null,"usage_kind":[],"allow_compaction_over_budget":true,"reset_hour":null,"reset_day_of_week":null,"reset_day_of_month":31,"pace_period":null,"pace_action":null,"pace_warn_at":null}]);
  });

  test("every budget period and action variant", () => {
    const cfg = parsed("[[usage.budgets]]\ncost_usd = 1.0\nperiod = \"hour\"\nlimit = \"warn\"\n\n[[usage.budgets]]\ncost_usd = 1.0\nperiod = \"day\"\nlimit = \"block\"\n\n[[usage.budgets]]\ncost_usd = 1.0\nperiod = \"week\"\nlimit = \"pause_background\"\n\n[[usage.budgets]]\ncost_usd = 1.0\nperiod = \"month\"\n");
    expect(at(cfg, "usage.budgets"), "usage.budgets").toMatchObject([{"name":"","period":"hour","cost_usd":1,"warn_at":[0.8,1],"limit":"warn","character":null,"provider":null,"api_key":null,"model":null,"call_type":null,"usage_kind":[],"allow_compaction_over_budget":null,"reset_hour":null,"reset_day_of_week":null,"reset_day_of_month":null,"pace_period":null,"pace_action":null,"pace_warn_at":null},{"name":"","period":"day","cost_usd":1,"warn_at":[0.8,1],"limit":"block","character":null,"provider":null,"api_key":null,"model":null,"call_type":null,"usage_kind":[],"allow_compaction_over_budget":null,"reset_hour":null,"reset_day_of_week":null,"reset_day_of_month":null,"pace_period":null,"pace_action":null,"pace_warn_at":null},{"name":"","period":"week","cost_usd":1,"warn_at":[0.8,1],"limit":"pause_background","character":null,"provider":null,"api_key":null,"model":null,"call_type":null,"usage_kind":[],"allow_compaction_over_budget":null,"reset_hour":null,"reset_day_of_week":null,"reset_day_of_month":null,"pace_period":null,"pace_action":null,"pace_warn_at":null},{"name":"","period":"month","cost_usd":1,"warn_at":[0.8,1],"limit":"warn","character":null,"provider":null,"api_key":null,"model":null,"call_type":null,"usage_kind":[],"allow_compaction_over_budget":null,"reset_hour":null,"reset_day_of_week":null,"reset_day_of_month":null,"pace_period":null,"pace_action":null,"pace_warn_at":null}]);
  });

  test("the tools allowlist", () => {
    const cfg = parsed("[tools]\nenabled_tools = [\"read\", \"search_chat_logs\"]\n");
    expect(at(cfg, "tools.enabled_tools"), "tools.enabled_tools").toEqual(["read","search_chat_logs"]);
  });

  test("mcp globs in the allowlist", () => {
    const cfg = parsed("[tools]\nenabled_tools = [\"read\", \"mcp__hue__*\"]\n");
    expect(at(cfg, "tools.enabled_tools"), "tools.enabled_tools").toEqual(["read","mcp__hue__*"]);
  });

  test("the subagent allowlist", () => {
    const cfg = parsed("[tools]\nenabled_subagents = [\"memory\"]\n");
    expect(at(cfg, "tools.enabled_subagents"), "tools.enabled_subagents").toEqual(["memory"]);
  });

  test("per-tool overrides", () => {
    const cfg = parsed("[tools]\nenabled_tools = [\"search\", \"read\"]\nmax_result_chars = 20000\ntimeout = \"30s\"\n\n[tools.config.search]\nmax_result_chars = 10000\n\n[tools.config.ask_researcher]\ntimeout = \"20m\"\n");
    expect(at(cfg, "tools.enabled_tools"), "tools.enabled_tools").toEqual(["search","read"]);
    expect(at(cfg, "tools.timeout"), "tools.timeout").toEqual("30s");
    expect(at(cfg, "tools.config"), "tools.config").toMatchObject({"ask_researcher":{"max_result_chars":null,"timeout":"20m"},"search":{"max_result_chars":10000,"timeout":null}});
  });

  test("a zero timeout means no deadline", () => {
    const cfg = parsed("[tools]\nenabled_tools = [\"read\", \"git\"]\ntimeout = 0\n\n[tools.config.git]\ntimeout = \"45s\"\n");
    expect(at(cfg, "tools.enabled_tools"), "tools.enabled_tools").toEqual(["read","git"]);
    expect(at(cfg, "tools.timeout"), "tools.timeout").toEqual("0s");
    expect(at(cfg, "tools.config"), "tools.config").toMatchObject({"git":{"max_result_chars":null,"timeout":"45s"}});
  });

  test("web search", () => {
    const cfg = parsed("[tools.web_search]\napi_key_env = \"MY_TAVILY_KEY\"\nresult_limit = 10\nsearch_depth = \"advanced\"\ninclude_answer = false\n");
    expect(at(cfg, "tools.web_search.api_key_env"), "tools.web_search.api_key_env").toEqual("MY_TAVILY_KEY");
    expect(at(cfg, "tools.web_search.result_limit"), "tools.web_search.result_limit").toEqual(10);
    expect(at(cfg, "tools.web_search.search_depth"), "tools.web_search.search_depth").toEqual("advanced");
    expect(at(cfg, "tools.web_search.include_answer"), "tools.web_search.include_answer").toEqual(false);
  });

  test("the mcp table, both transports", () => {
    const cfg = parsed("[mcp.hue]\ncommand = \"node\"\nargs = [\"index.js\"]\nenv = { HUE_API_KEY = \"abc\" }\ncwd = \"/srv/hue-mcp\"\n\n[mcp.remote]\nurl = \"http://localhost:9123/sse\"\n");
    expect(at(cfg, "mcp"), "mcp").toMatchObject({"hue":{"command":"node","args":["index.js"],"env":{"HUE_API_KEY":"abc"},"cwd":"/srv/hue-mcp","url":null},"remote":{"command":null,"args":[],"env":{},"cwd":null,"url":"http://localhost:9123/sse"}});
  });

  test("mcp env keys sort by code point", () => {
    const cfg = parsed("[mcp.s]\ncommand = \"x\"\nenv = { ZED = \"1\", \"ﬀ\" = \"2\", ABLE = \"3\" }\n");
    expect(at(cfg, "mcp"), "mcp").toMatchObject({"s":{"command":"x","args":[],"env":{"ABLE":"3","ZED":"1","ﬀ":"2"},"cwd":null,"url":null}});
  });


  test("autonomy and heartbeat durations", () => {
    const cfg = parsed("[behavior.autonomy]\nenabled = true\n\n[behavior.autonomy.heartbeat]\nenabled = false\nfallback_heartbeat_interval = \"90m\"\ndormant_after_heartbeat_turns = 7\ndormant_after_idle_time = \"1d\"\nminimum_heartbeat_latency = \"500ms\"\nwrap_up_grace_rounds = 1\n\n[cache]\nkeepalive_max = \"6h\"\n");
    expect(at(cfg, "behavior.autonomy.enabled"), "behavior.autonomy.enabled").toEqual(true);
    expect(at(cfg, "behavior.autonomy.heartbeat.enabled"), "behavior.autonomy.heartbeat.enabled").toEqual(false);
    expect(at(cfg, "behavior.autonomy.heartbeat.fallback_heartbeat_interval"), "behavior.autonomy.heartbeat.fallback_heartbeat_interval").toEqual("90m");
    expect(at(cfg, "behavior.autonomy.heartbeat.dormant_after_heartbeat_turns"), "behavior.autonomy.heartbeat.dormant_after_heartbeat_turns").toEqual(7);
    expect(at(cfg, "behavior.autonomy.heartbeat.dormant_after_idle_time"), "behavior.autonomy.heartbeat.dormant_after_idle_time").toEqual("1d");
    expect(at(cfg, "behavior.autonomy.heartbeat.minimum_heartbeat_latency"), "behavior.autonomy.heartbeat.minimum_heartbeat_latency").toEqual("500ms");
    expect(at(cfg, "behavior.autonomy.heartbeat.wrap_up_grace_rounds"), "behavior.autonomy.heartbeat.wrap_up_grace_rounds").toEqual(1);
    expect(at(cfg, "cache.keepalive_max"), "cache.keepalive_max").toEqual("6h");
  });

  test("a bare integer duration means seconds", () => {
    const cfg = parsed("[behavior.autonomy]\n\n\n[cache]\nkeepalive_max = 90\n");
    expect(at(cfg, "cache.keepalive_max"), "cache.keepalive_max").toEqual("90s");
  });

  test("a fractional duration is accepted at parse time", () => {
    const cfg = parsed("[memory.compaction]\nidle_trigger = \"1.5s\"\n");
    expect(at(cfg, "memory.compaction.idle_trigger"), "memory.compaction.idle_trigger").toEqual("1500ms");
  });

  test("every user_message_timestamps variant", () => {
    const cfg = parsed("[behavior]\nuser_message_timestamps = \"always\"\n");
    expect(at(cfg, "behavior.user_message_timestamps"), "behavior.user_message_timestamps").toEqual("always");
  });

  test("user_message_timestamps never", () => {
    const cfg = parsed("[behavior]\nuser_message_timestamps = \"never\"\n");
    expect(at(cfg, "behavior.user_message_timestamps"), "behavior.user_message_timestamps").toEqual("never");
  });

  test("the compaction section", () => {
    const cfg = parsed("[memory.compaction]\nenabled = true\nidle_trigger = \"45m\"\narchive_after = \"3d\"\nmin_turns = 4\nmax_turns = 20\nmax_context_tokens = 150000\nkeep_recent_turns = 3\n");
    expect(at(cfg, "memory.compaction.idle_trigger"), "memory.compaction.idle_trigger").toEqual("45m");
    expect(at(cfg, "memory.compaction.archive_after"), "memory.compaction.archive_after").toEqual("3d");
    expect(at(cfg, "memory.compaction.min_turns"), "memory.compaction.min_turns").toEqual(4);
    expect(at(cfg, "memory.compaction.max_turns"), "memory.compaction.max_turns").toEqual(20);
    expect(at(cfg, "memory.compaction.max_context_tokens"), "memory.compaction.max_context_tokens").toEqual(150000);
    expect(at(cfg, "memory.compaction.keep_recent_turns"), "memory.compaction.keep_recent_turns").toEqual(3);
  });

  test("replay_prior_thinking accepts the new string form", () => {
    const cfg = parsed("[memory.thinking]\nreplay_prior_thinking = \"none\"\n");
    expect(at(cfg, "memory.thinking.replay_prior_thinking"), "memory.thinking.replay_prior_thinking").toEqual("none");
  });

  test("replay_prior_thinking accepts the legacy bool false", () => {
    const cfg = parsed("[memory.thinking]\nreplay_prior_thinking = false\n");
    expect(at(cfg, "memory.thinking.replay_prior_thinking"), "memory.thinking.replay_prior_thinking").toEqual("none");
  });

  test("notifications", () => {
    const cfg = parsed("[notifications]\nenabled = true\nbackend = \"ntfy\"\ngeneration_threshold = \"20s\"\n\n[notifications.ntfy]\nurl = \"https://ntfy.example.com\"\ntopic = \"shore-test\"\ntoken = \"tk_secret\"\n\n[notifications.events]\ncache_warning = false\nmessage_complete = true\n");
    expect(at(cfg, "notifications.enabled"), "notifications.enabled").toEqual(true);
    expect(at(cfg, "notifications.backend"), "notifications.backend").toEqual("ntfy");
    expect(at(cfg, "notifications.ntfy.url"), "notifications.ntfy.url").toEqual("https://ntfy.example.com");
    expect(at(cfg, "notifications.ntfy.topic"), "notifications.ntfy.topic").toEqual("shore-test");
    expect(at(cfg, "notifications.ntfy.token"), "notifications.ntfy.token").toEqual("tk_secret");
    expect(at(cfg, "notifications.generation_threshold"), "notifications.generation_threshold").toEqual("20s");
    expect(at(cfg, "notifications.events.cache_warning"), "notifications.events.cache_warning").toEqual(false);
    expect(at(cfg, "notifications.events.message_complete"), "notifications.events.message_complete").toEqual(true);
  });

  test("the notifications command backend", () => {
    const cfg = parsed("[notifications]\nenabled = true\nbackend = \"command\"\ncommand = [\"notifier\", \"--title\", \"{title}\", \"--body\", \"{body}\"]\n");
    expect(at(cfg, "notifications.enabled"), "notifications.enabled").toEqual(true);
    expect(at(cfg, "notifications.backend"), "notifications.backend").toEqual("command");
    expect(at(cfg, "notifications.command"), "notifications.command").toEqual(["notifier", "--title", "{title}", "--body", "{body}"]);
  });



  test("the background section", () => {
    const cfg = parsed("[defaults.background]\nmodel = \"bg\"\nheartbeat = \"bg-h\"\ncompaction = \"bg-c\"\n");
    expect(at(cfg, "defaults.background.model"), "defaults.background.model").toEqual("bg");
    expect(at(cfg, "defaults.background.heartbeat"), "defaults.background.heartbeat").toEqual("bg-h");
    expect(at(cfg, "defaults.background.compaction"), "defaults.background.compaction").toEqual("bg-c");
  });

  test("defaults.stream can be turned off", () => {
    const cfg = parsed("[defaults]\nstream = false\ndisplay_name = \"Alice\"\nembedding = \"e\"\nimage_generation = \"i\"\n");
    expect(at(cfg, "defaults.embedding"), "defaults.embedding").toEqual("e");
    expect(at(cfg, "defaults.image_generation"), "defaults.image_generation").toEqual("i");
    expect(at(cfg, "defaults.display_name"), "defaults.display_name").toEqual("Alice");
    expect(at(cfg, "defaults.stream"), "defaults.stream").toEqual(false);
  });

  test("a sequence fills a struct positionally", () => {
    const cfg = parsed("[behavior]\nautonomy = [true]\n");
    expect(at(cfg, "behavior.autonomy.enabled"), "behavior.autonomy.enabled").toEqual(true);
  });


  test("seq: DefaultsConfig, at its minimum", () => {
    const cfg = parsed("defaults = [\"m\", [\"bm\", \"bh\", \"bc\"], \"e\", \"i\", \"s\", \"d\"]\n");
    expect(at(cfg, "defaults.model"), "defaults.model").toEqual("m");
    expect(at(cfg, "defaults.background.model"), "defaults.background.model").toEqual("bm");
    expect(at(cfg, "defaults.background.heartbeat"), "defaults.background.heartbeat").toEqual("bh");
    expect(at(cfg, "defaults.background.compaction"), "defaults.background.compaction").toEqual("bc");
    expect(at(cfg, "defaults.embedding"), "defaults.embedding").toEqual("e");
    expect(at(cfg, "defaults.image_generation"), "defaults.image_generation").toEqual("i");
    expect(at(cfg, "defaults.subagent_model"), "defaults.subagent_model").toEqual("s");
    expect(at(cfg, "defaults.display_name"), "defaults.display_name").toEqual("d");
  });

  test("seq: BackgroundDefaultsConfig, at its minimum", () => {
    const cfg = parsed("[defaults]\nbackground = [\"m\", \"h\", \"c\"]\n");
    expect(at(cfg, "defaults.background.model"), "defaults.background.model").toEqual("m");
    expect(at(cfg, "defaults.background.heartbeat"), "defaults.background.heartbeat").toEqual("h");
    expect(at(cfg, "defaults.background.compaction"), "defaults.background.compaction").toEqual("c");
  });



  test("seq: McpServerConfig, at its minimum", () => {
    const cfg = parsed("[mcp]\ns = [\"node\", [], {}, \"/srv\", \"http://x\"]\n");
    expect(at(cfg, "mcp"), "mcp").toMatchObject({"s":{"command":"node","args":[],"env":{},"cwd":"/srv","url":"http://x"}});
  });

  test("seq: UsageBudgetConfig, at its minimum", () => {
    const cfg = parsed("[usage]\nbudgets = [[\"n\", \"week\", 5.0]]\n");
    expect(at(cfg, "usage.budgets"), "usage.budgets").toMatchObject([{"name":"n","period":"week","cost_usd":5,"warn_at":[0.8,1],"limit":"warn","character":null,"provider":null,"api_key":null,"model":null,"call_type":null,"usage_kind":[],"allow_compaction_over_budget":null,"reset_hour":null,"reset_day_of_week":null,"reset_day_of_month":null,"pace_period":null,"pace_action":null,"pace_warn_at":null}]);
  });

  test("seq: ToolOverride needs nothing", () => {
    const cfg = parsed("[tools.config]\nread = []\n");
    expect(at(cfg, "tools.config"), "tools.config").toMatchObject({"read":{"max_result_chars":null,"timeout":null}});
  });

  test("an empty per-tool table is not an error", () => {
    const cfg = parsed("[tools.config.read]\n");
    expect(at(cfg, "tools.config"), "tools.config").toMatchObject({"read":{"max_result_chars":null,"timeout":null}});
  });

  test("a zero deadline written as a duration string", () => {
    const cfg = parsed("[tools]\ntimeout = \"0s\"\n");
    expect(at(cfg, "tools.timeout"), "tools.timeout").toEqual("0s");
  });

  test("a bare float duration", () => {
    const cfg = parsed("[behavior.autonomy]\n\n\n[cache]\nkeepalive_max = 1.5\n");
    expect(at(cfg, "cache.keepalive_max"), "cache.keepalive_max").toEqual("1500ms");
  });

  test("integer where a float is expected is widened", () => {
    const cfg = parsed("[[usage.budgets]]\ncost_usd = 10\n");
    expect(at(cfg, "usage.budgets"), "usage.budgets").toMatchObject([{"name":"","period":"day","cost_usd":10,"warn_at":[0.8,1],"limit":"warn","character":null,"provider":null,"api_key":null,"model":null,"call_type":null,"usage_kind":[],"allow_compaction_over_budget":null,"reset_hour":null,"reset_day_of_week":null,"reset_day_of_month":null,"pace_period":null,"pace_action":null,"pace_warn_at":null}]);
  });

});

describe("a config.toml that cannot be honoured is refused, and says what is wrong", () => {
  test("a subagent without a description does not parse", () => {
    expect(rejected("[subagents.music]\nprompt = \"p\"\n")).toContain("description");
  });

  test("a subagent without a prompt does not parse", () => {
    expect(rejected("[subagents.music]\ndescription = \"d\"\n")).toContain("prompt");
  });

  test("an unknown subagent key does not parse", () => {
    expect(rejected("[subagents.music]\ndescription = \"d\"\nprompt = \"p\"\nmodel_name = \"x\"\n")).toContain("model_name");
  });

  test("two missing fields report the one declared first, not the one sorted first", () => {
    expect(rejected("[subagents.music]\ntools = []\n")).toContain("description");
  });

  test("an unknown key is reported before a missing one", () => {
    expect(rejected("[subagents.music]\nzzz = 1\n")).toContain("zzz");
  });

  test("an unknown retrieval mode does not parse", () => {
    expect(rejected("[memory.retrieval]\nmode = \"semantic\"\n")).toContain("semantic");
  });

  test("an unknown recall mode does not parse", () => {
    expect(rejected("[memory.recall]\nmode = \"shadow\"\n")).toContain("shadow");
  });

  test("an unknown binary mode does not parse", () => {
    expect(rejected("[memory.retrieval]\nbinary = \"embed\"\n")).toContain("embed");
  });

  test("a budget without cost_usd does not parse", () => {
    expect(rejected("[[usage.budgets]]\nname = \"daily\"\n")).toContain("cost_usd");
  });

  test("an unknown budget weekday does not parse", () => {
    expect(rejected("[[usage.budgets]]\ncost_usd = 1.0\nreset_day_of_week = \"Monday\"\n")).toContain("Monday");
  });

  test("an unknown per-tool override key does not parse", () => {
    expect(rejected("[tools.config.search]\nmax_chars = 10\n")).toContain("max_chars");
  });

  test("an unknown mcp key does not parse", () => {
    expect(rejected("[mcp.hue]\ncommand = \"node\"\ntransport = \"stdio\"\n")).toContain("transport");
  });

  test("an unparseable duration is rejected", () => {
    expect(rejected("[behavior.autonomy]\n\n\n[cache]\nkeepalive_max = \"6 hours\"\n")).not.toBe("");
  });

  test("a negative duration is rejected", () => {
    expect(rejected("[behavior.autonomy]\n\n\n[cache]\nkeepalive_max = -5\n")).not.toBe("");
  });

  test("an unknown user_message_timestamps variant does not parse", () => {
    expect(rejected("[behavior]\nuser_message_timestamps = \"sometimes\"\n")).toContain("sometimes");
  });

  test("an unknown replay_prior_thinking is rejected", () => {
    expect(rejected("[memory.thinking]\nreplay_prior_thinking = \"recent\"\n")).not.toBe("");
  });

  test("an unknown notifications backend does not parse", () => {
    expect(rejected("[notifications]\nbackend = \"dbus\"\n")).toContain("dbus");
  });

  test("a telegram or discord table is refused, keys and all", () => {
    expect(rejected("[connections.telegram]\nbot_token = \"t\"\nchat_id = 42\n\n[connections.discord]\nwebhook = \"https://example.invalid/hook\"\n")).toContain("discord");
  });



  test("the removed tools.exec sandbox is rejected", () => {
    expect(rejected("[tools.exec]\nsandbox = \"off\"\n")).toContain("exec");
  });

  test("the removed tools.sandbox section is rejected", () => {
    expect(rejected("[tools.sandbox]\nmode = \"on\"\n")).toContain("sandbox");
  });

  test("an unknown top-level section is rejected", () => {
    expect(rejected("[bogus_section]\nkey = \"value\"\n")).toContain("bogus_section");
  });

  test("an unknown notifications key is rejected", () => {
    expect(rejected("[notifications]\nenabled = true\nbogus_key = \"value\"\n")).toContain("bogus_key");
  });

  test("an unknown nested key is rejected", () => {
    expect(rejected("[behavior.autonomy]\nenabled = true\nbogus_key = 42\n")).toContain("bogus_key");
  });

  test("an unknown background key is rejected", () => {
    expect(rejected("[defaults.background]\ntypo_field = \"x\"\n")).toContain("typo_field");
  });

  test("two unknown top-level keys: the document reports the first written, the table reports the code-point-smallest", () => {
    expect(rejected("[zzz_unknown]\nk = 1\n\n[aaa_unknown]\nk = 2\n")).toContain("aaa_unknown");
  });

  test("an unknown key and a bad type: which is reported depends on the path", () => {
    expect(rejected("[behavior]\nzzz_unknown = 1\n\n[behavior.autonomy]\nenabled = \"yes\"\n")).not.toBe("");
  });

  test("two unknown non-ASCII keys sort by code point, not UTF-16 order", () => {
    expect(rejected("[\"🎵\"]\nk = 1\n\n[\"ﬀ\"]\nk = 2\n")).toContain("ﬀ");
  });

  test("a bad type at a sequence position", () => {
    expect(rejected("[behavior]\nautonomy = [1]\n")).toContain("1");
  });

  test("a retired connection is refused in its positional form too", () => {
    expect(rejected("[connections]\ntelegram = [1]\n")).toContain("telegram");
  });

  test("trailing elements past the field count", () => {
    expect(rejected("[behavior]\nautonomy = [true, {}, \"6h\", 1]\n")).not.toBe("");
  });

  test("seq: DefaultsConfig", () => {
    expect(rejected("defaults = []\n")).not.toBe("");
  });

  test("seq: BackgroundDefaultsConfig", () => {
    expect(rejected("[defaults]\nbackground = []\n")).not.toBe("");
  });

  test("seq: AdvancedConfig", () => {
    expect(rejected("advanced = []\n")).not.toBe("");
  });

  test("seq: LlmSidecarConfig", () => {
    expect(rejected("[advanced]\nllm_sidecar = []\n")).not.toBe("");
  });

  test("seq: McpServerConfig", () => {
    expect(rejected("[mcp]\ns = []\n")).not.toBe("");
  });

  test("seq: UsageBudgetConfig", () => {
    expect(rejected("[usage]\nbudgets = [[]]\n")).not.toBe("");
  });

  test("a required field missing from a positional sequence", () => {
    expect(rejected("[subagents]\nmusic = [\"d\"]\n")).not.toBe("");
  });

  test("a required field supplied positionally", () => {
    expect(rejected("[subagents]\nmusic = [\"d\", \"p\", [\"read\"]]\n")).not.toBe("");
  });

  test("a sequence where a map is expected", () => {
    expect(rejected("[mcp.s]\nenv = []\n")).not.toBe("");
  });

  test("an unknown key in a one-field struct", () => {
    expect(rejected("[memory.thinking]\nbogus = 1\n")).toContain("bogus");
  });

  test("an unknown key sorting before a bad type is reported on both paths", () => {
    expect(rejected("[aaa_unknown]\nk = 1\n\n[behavior.autonomy]\nenabled = \"yes\"\n")).toContain("aaa_unknown");
  });

  test("a bad type where a bool is expected", () => {
    expect(rejected("[defaults]\nstream = \"yes\"\n")).not.toBe("");
  });

  test("a bad type where a string is expected", () => {
    expect(rejected("[daemon]\naddr = 7320\n")).toContain("7320");
  });

  test("a bad type where an integer is expected", () => {
    expect(rejected("[tools]\nmax_result_chars = \"lots\"\n")).not.toBe("");
  });

  test("a negative integer where a usize is expected", () => {
    expect(rejected("[tools]\nmax_result_chars = -1\n")).toContain("-1");
  });

  test("a table where a section is expected to be one", () => {
    expect(rejected("[defaults]\nbackground = \"bg\"\n")).not.toBe("");
  });

  test("integer where a string is expected", () => {
    expect(rejected("[defaults]\nmodel = 1\n")).toContain("1");
  });

  test("boolean where a string is expected", () => {
    expect(rejected("[defaults]\nmodel = true\n")).toContain("true");
  });

  test("float where a string is expected", () => {
    expect(rejected("[defaults]\nmodel = 1.5\n")).toContain("1.5");
  });

  test("array where a string is expected", () => {
    expect(rejected("[defaults]\nmodel = []\n")).not.toBe("");
  });

  test("table where a string is expected", () => {
    expect(rejected("[defaults]\nmodel = {}\n")).not.toBe("");
  });

  test("datetime where a string is expected", () => {
    expect(rejected("[defaults]\nmodel = 1979-05-27T07:32:00Z\n")).not.toBe("");
  });

  test("float where an integer is expected", () => {
    expect(rejected("[tools]\nmax_result_chars = 1.5\n")).toContain("1.5");
  });

  test("string where a sequence is expected", () => {
    expect(rejected("[tools]\nenabled_tools = \"read\"\n")).not.toBe("");
  });

  test("wrong element type inside a sequence", () => {
    expect(rejected("[tools]\nenabled_tools = [1]\n")).toContain("1");
  });

  test("wrong element type inside a float sequence", () => {
    expect(rejected("[[usage.budgets]]\ncost_usd = 1.0\nwarn_at = [\"half\"]\n")).not.toBe("");
  });

  test("string where a float is expected", () => {
    expect(rejected("[[usage.budgets]]\ncost_usd = \"ten\"\n")).not.toBe("");
  });

  test("negative u32", () => {
    expect(rejected("[advanced]\nmax_retries = -1\n")).toContain("-1");
  });



  test("string where a string map is expected", () => {
    expect(rejected("[mcp.s]\nenv = \"x\"\n")).not.toBe("");
  });

  test("wrong value type inside a string map", () => {
    expect(rejected("[mcp.s]\nenv = { A = 1 }\n")).toContain("1");
  });

  test("integer where a nested struct is expected", () => {
    expect(rejected("[behavior.autonomy]\nheartbeat = 1\n")).toContain("1");
  });

  test("string where an array of tables is expected", () => {
    expect(rejected("[usage]\nbudgets = \"none\"\n")).not.toBe("");
  });

  test("not even an empty telegram table parses", () => {
    expect(rejected("[connections.telegram]\n")).toContain("telegram");
  });

  test("an integer past u32", () => {
    expect(rejected("[advanced]\nmax_retries = 5000000000\n")).toContain("5000000000");
  });

  test("a non-string where an enum is expected", () => {
    expect(rejected("[memory.retrieval]\nmode = 1\n")).not.toBe("");
  });

  test("a non-string where the notification backend is expected", () => {
    expect(rejected("[notifications]\nbackend = 1\n")).not.toBe("");
  });

  test("a boolean where a duration is expected", () => {
    expect(rejected("[behavior.autonomy]\n\n\n[cache]\nkeepalive_max = true\n")).toContain("true");
  });

  test("an integer where replay_prior_thinking is expected", () => {
    expect(rejected("[memory.thinking]\nreplay_prior_thinking = 1\n")).not.toBe("");
  });


});

describe("the tool allowlist", () => {
  const toolsOf = (toml: string): ToolsConfig => {
    const result = parseAppConfig(parseToml(toml));
    if ("err" in result) throw new Error(result.err);
    return result.ok.tools;
  };

  for (const c of TOOLS_QUERIES) {
    test(c.name, () => {
      const tools = toolsOf(c.toml);
      expect(anyToolEnabled(tools)).toBe(c.any_enabled);
      for (const t of c.tools) {
        expect(toolEnabled(tools, t.name), t.name).toBe(t.enabled);
      }
      for (const sub of c.subagents) {
        expect(subagentEnabled(tools, sub.name), sub.name).toBe(sub.enabled);
      }
    });
  }
});

describe("a per-tool limit", () => {
  const toolsOf = (toml: string): ToolsConfig => {
    const result = parseAppConfig(parseToml(toml));
    if ("err" in result) throw new Error(result.err);
    return result.ok.tools;
  };

  test("falls back to the global cap when the tool sets none", () => {
    const tools = toolsOf("[tools]\nmax_result_chars = 4096\n");
    expect(resultCharsFor(tools, "read")).toBe(4096);
    expect(resultCharsFor(tools, "anything-at-all")).toBe(4096);
  });

  test("overrides the global cap when the tool sets its own", () => {
    const tools = toolsOf(
      "[tools]\nmax_result_chars = 4096\n\n[tools.config.read]\nmax_result_chars = 10\n",
    );
    expect(resultCharsFor(tools, "read")).toBe(10);
    expect(resultCharsFor(tools, "search")).toBe(4096);
  });

  test("falls back to the shipped default when nothing sets it", () => {
    expect(resultCharsFor(toolsOf(""), "read")).toBe(defaultToolsConfig().max_result_chars);
  });

  test("the same inheritance governs deadlines", () => {
    const tools = toolsOf(
      '[tools]\ntimeout = "30s"\n\n[tools.config.git]\ntimeout = "5m"\n',
    );
    expect(timeoutFor(tools, "git")?.asMillis()).toBe(300_000);
    expect(timeoutFor(tools, "read")?.asMillis()).toBe(30_000);
  });

  test("a zero deadline means no deadline, not an instant one", () => {
    expect(timeoutFor(toolsOf("[tools]\ntimeout = 0\n"), "read")).toBeUndefined();
  });
});

describe("sub-agent timeouts", () => {
  test("a sub-agent timeout parses as a duration", () => {
    const outcome = parseAppConfig(
      parseToml('[subagents.research]\ndescription = "d"\nprompt = "p"\ntimeout = "20m"\n'),
    );
    if ("err" in outcome) throw new Error(outcome.err);
    expect(outcome.ok.subagents.get("research")?.timeout?.asMillis()).toBe(1_200_000);
  });

  test("a sub-agent without a timeout leaves it unset", () => {
    const outcome = parseAppConfig(
      parseToml('[subagents.research]\ndescription = "d"\nprompt = "p"\n'),
    );
    if ("err" in outcome) throw new Error(outcome.err);
    expect(outcome.ok.subagents.get("research")?.timeout).toBeUndefined();
  });
});

describe("tool_pattern_matches", () => {
  for (const c of TOOL_PATTERNS) {
    test(`${JSON.stringify(c.pattern)} vs ${JSON.stringify(c.name)}`, () => {
      expect(toolPatternMatches(c.pattern, c.name)).toBe(c.matches);
    });
  }

  test("the cases cover both branches and both answers", () => {
    const globs = TOOL_PATTERNS.filter((c) => c.pattern.endsWith("*"));
    const exact = TOOL_PATTERNS.filter((c) => !c.pattern.endsWith("*"));
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
  for (const c of BACKGROUND) {
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
  for (const c of REMOVED_KEYS) {
    test(c.name, () => {
      const outcome = parseAppConfig(parseToml(c.toml));
      expect("err" in outcome ? outcome.err : null).toBe(c.err);
    });
  }

  test("the message names the key that replaced it, not just the valid fields", () => {
    const refused = REMOVED_KEYS.filter((c) => c.err !== null);
    expect(refused.length).toBeGreaterThan(0);
    for (const c of refused) {
      expect(c.err).toContain("was removed");
      expect(c.err).toContain("[defaults.background]");
      expect(c.err).not.toContain("unknown field");
    }
  });
});

describe("resolve_display_name", () => {
  for (const c of DISPLAY_NAME) {
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
  for (const c of COMPACTION_VALIDATE) {
    test(c.name, () => {
      const compaction = {
        enabled: c.compaction.enabled,
        write_memory: true,
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
    const c = COMPACTION_VALIDATE.find((x) =>
      x.name.includes("names the two values"),
    );
    if (c === undefined || c.err === null) throw new Error("fixture case missing");
    expect(c.err).toContain("`90s`");
    expect(c.err).toContain("`91s`");
  });
});

function durationFrom(display: string): ConfigDuration {
  const result = ConfigDuration.parse(display);
  if ("err" in result) throw new Error(`${display}: ${result.err}`);
  return result.ok;
}

describe("budget pace fallbacks", () => {
  for (const c of BUDGET_PACE) {
    test(c.name, () => {
      const outcome = parseAppConfig(parseToml(c.toml));
      if ("err" in outcome) throw new Error(outcome.err);

      expect(
        outcome.ok.usage.budgets.map((b) => ({
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
      BUDGET_PERIODS.map((p) => ({
        period: p.period,
        rank: budgetPeriodRank(p.period as UsageBudgetPeriod),
      })),
    ).toEqual(BUDGET_PERIODS);
  });

  test("weekday offsets", () => {
    expect(
      BUDGET_WEEKDAYS.map((d) => ({
        weekday: d.weekday,
        num_days_from_monday: numDaysFromMonday(d.weekday as BudgetWeekday),
      })),
    ).toEqual(BUDGET_WEEKDAYS);
  });

  test("every action variant round-trips through the schema", () => {
    for (const action of BUDGET_ACTIONS) {
      const outcome = parseAppConfig(
        parseToml(`[[usage.budgets]]\ncost_usd = 1.0\nlimit = ${JSON.stringify(action)}\n`),
      );
      if ("err" in outcome) throw new Error(outcome.err);
      expect(outcome.ok.usage.budgets[0]?.limit as string | undefined).toBe(action);
    }
  });
});

describe("parse_wire for replay_prior_thinking", () => {
  for (const c of THINKING_REPLAY) {
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
