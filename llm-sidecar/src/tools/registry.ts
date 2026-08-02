/**
 * The tool-definition registry: what the model is offered, and in what order.
 *
 * Ported from the definition half of `crates/daemon/src/tools/mod.rs`, pinned
 * by `tests/tools_fixtures/tool_registry_parity.json`.
 *
 * # Order is the cache key
 *
 * Anthropic caches on a prefix match and the tools array is the head of that
 * prefix, so the order tools are offered in is load-bearing in a way that is
 * invisible until a bill arrives. Three orderings matter and all three are
 * pinned by the fixture:
 *
 * 1. **Registry order** — {@link ALL_TOOLS}, which is where the Rust's
 *    seven-module concatenation ends up. The allowlist filters this list; it
 *    never reorders it, so listing `enabled_tools` in a different order in
 *    config changes nothing.
 * 2. **Sub-agent order** — sorted by name, because the Rust held them in a
 *    `BTreeMap`. See {@link subagentToolDefs} for why that sort cannot be
 *    `.sort()`.
 * 3. **Group order** — static, then `ask_<name>`, then MCP. That is
 *    {@link assembleToolSurface}, and it is the whole reason that function
 *    exists rather than three `concat`s at the call site.
 *
 * # What is not here
 *
 * Dispatch. `dispatch_tool` and the `ToolContext` trait stay Rust until
 * `swp_server` moves, because executing a tool emits `ToolCall` / `ToolResult`
 * / `SendImage` straight onto the client stream — see #18. This file is only
 * the surface a request is built from, which has no such dependency.
 *
 * # Divergence from the Rust: one file, not seven
 *
 * Each Rust tool module carried its own `tool_defs()` and `all_tools()`
 * concatenated them, so the offer order lived in a seven-line function nowhere
 * near the definitions it sequenced. The definitions are static data and the
 * order is the part that bites, so they are one list here. The handlers stay
 * in their own modules, where they have code to be near.
 */

import { renderTemplate, stripOneTrailingNewline } from "../engine/prompt.ts";
import type { ToolDefinition } from "../llm/types.ts";

import activityHeatmapDesc from "../../../crates/daemon/prompts/tools/activity/activity_heatmap.md" with { type: "text" };
import rollDiceDesc from "../../../crates/daemon/prompts/tools/basic/roll_dice.md" with { type: "text" };
import modelHistoryDesc from "../../../crates/daemon/prompts/tools/history/model_history.md" with { type: "text" };
import searchHistoryDesc from "../../../crates/daemon/prompts/tools/history/search_history.md" with { type: "text" };
import generateImageDesc from "../../../crates/daemon/prompts/tools/images/generate_image.md" with { type: "text" };
import fetchUrlDesc from "../../../crates/daemon/prompts/tools/web/fetch_url.md" with { type: "text" };
import webSearchDesc from "../../../crates/daemon/prompts/tools/web/web_search.md" with { type: "text" };
import deleteDesc from "../../../crates/daemon/prompts/tools/workspace/delete.md" with { type: "text" };
import editDesc from "../../../crates/daemon/prompts/tools/workspace/edit.md" with { type: "text" };
import gitDesc from "../../../crates/daemon/prompts/tools/workspace/git.md" with { type: "text" };
import readDesc from "../../../crates/daemon/prompts/tools/workspace/read.md" with { type: "text" };
import searchDesc from "../../../crates/daemon/prompts/tools/workspace/search.md" with { type: "text" };

/** Coarse capability grouping. Carried for parity; nothing routes on it yet. */
export type ToolCategory = "web" | "other";

/**
 * A registered tool's static definition.
 *
 * `description` is the raw template — `{{char}}` / `{{user}}` are rendered by
 * {@link renderToolDefs} on the way out, never here, so the registry stays a
 * constant.
 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: ToolCategory;
}

/**
 * The fields of `[tools]` this module reads.
 *
 * Deliberately narrow: the full `ToolsConfig` port comes with the config
 * module, and widening this to match it early would mean maintaining a second
 * copy of a 10,000-line schema for two string arrays.
 */
export interface ToolsConfigView {
  enabled_tools: string[];
  enabled_subagents: string[];
}

/** The `[subagents.<name>]` fields this module reads. */
export interface SubagentConfigView {
  description: string;
}

/**
 * Every registered tool, in offer order.
 *
 * The order is `images, web, activity, basic, workspace, history,
 * model_history` — the concatenation order of the Rust's `all_tools()`. It
 * looks arbitrary because it is: it is whatever order the modules were added
 * in, frozen by the cache. Do not sort it.
 */
export const ALL_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: "generate_image",
    description: stripOneTrailingNewline(generateImageDesc),
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text prompt for image generation." },
        size: {
          type: "string",
          description: "Image dimensions (e.g. '1024x1024').",
          default: "1024x1024",
        },
        caption: {
          type: "string",
          description: "Optional caption to send with the generated image.",
        },
      },
      required: ["prompt"],
    },
    category: "other",
  },
  {
    name: "web_search",
    description: stripOneTrailingNewline(webSearchDesc),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: {
          type: "integer",
          description: "Maximum number of results to return.",
          default: 5,
        },
      },
      required: ["query"],
    },
    category: "web",
  },
  {
    name: "fetch_url",
    description: stripOneTrailingNewline(fetchUrlDesc),
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
      },
      required: ["url"],
    },
    category: "web",
  },
  {
    name: "activity_heatmap",
    description: stripOneTrailingNewline(activityHeatmapDesc),
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "Number of days of history to include.",
          default: 30,
        },
      },
    },
    category: "other",
  },
  {
    // `set_next_wake` is deliberately absent: it is a heartbeat-only
    // capability the tick loop intercepts by name. Declaring it would put a
    // tool that is meaningless in chat at the head of the cache prefix, and
    // any chat/heartbeat divergence there busts the cache.
    name: "roll_dice",
    description: stripOneTrailingNewline(rollDiceDesc),
    parameters: {
      type: "object",
      properties: {
        notation: {
          type: "string",
          description: "Dice notation: NdS[+/-M]. Examples: '2d6', '1d20+5', '4d6-1'.",
        },
      },
      required: ["notation"],
    },
    category: "other",
  },
  {
    name: "read",
    description: stripOneTrailingNewline(readDesc),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path within your workspace. A file path returns its contents; a directory path lists its entries. Omit for a listing of the workspace root.",
        },
        offset: {
          type: "number",
          description:
            "Line number to start reading from (1-based). Files only; ignored for directories. Optional.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of lines to read. Files only; ignored for directories. Optional.",
        },
      },
      required: [],
    },
    category: "other",
  },
  {
    name: "edit",
    description: stripOneTrailingNewline(editDesc),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path within your workspace." },
        content: {
          type: "string",
          description:
            "Full content for the file, creating it or overwriting it wholesale. Parent directories are created automatically. Mutually exclusive with `edits`.",
        },
        edits: {
          type: "array",
          description:
            "List of replacements to apply in order to an existing file. Mutually exclusive with `content`.",
          items: {
            type: "object",
            properties: {
              old_string: {
                type: "string",
                description:
                  "Exact text to find and replace. Must match whitespace and newlines precisely.",
              },
              new_string: {
                type: "string",
                description: "Text to replace old_string with.",
              },
              replace_all: {
                type: "boolean",
                description:
                  "Replace every occurrence of old_string. Defaults to false, which requires old_string to match exactly once.",
              },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path"],
    },
    category: "other",
  },
  {
    name: "search",
    description: stripOneTrailingNewline(searchDesc),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword, phrase, or natural-language description to search for.",
        },
        mode: {
          type: "string",
          enum: ["hybrid", "lexical", "vector"],
          description:
            "Ranking mode. `hybrid` (default) blends semantic similarity with substring matching. `lexical` is case-insensitive substring only, ordered by file recency. `vector` is pure semantic similarity.",
        },
        path: {
          type: "string",
          description:
            "Optional relative path to scope the search to a subtree. Works in all modes — hybrid/vector queries are filtered to this subtree after ranking against the workspace-wide embedding index.",
        },
        max_results: {
          type: "number",
          description: "Maximum matches to return. Defaults to 20, maximum 100.",
        },
      },
      required: ["query"],
    },
    category: "other",
  },
  {
    name: "delete",
    description: stripOneTrailingNewline(deleteDesc),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to remove, within your workspace.",
        },
      },
      required: ["path"],
    },
    category: "other",
  },
  {
    name: "git",
    description: stripOneTrailingNewline(gitDesc),
    parameters: {
      type: "object",
      properties: {
        subcommand: {
          type: "string",
          description:
            'The git subcommand to run, e.g. "status", "add", "commit", "log", "diff".',
        },
        args: {
          type: "array",
          description:
            'Arguments for the subcommand, one array element per argument. For example ["-m", "note why this matters"]. Optional.',
          items: { type: "string" },
        },
        workdir: {
          type: "string",
          description:
            "Directory to run in, relative to your workspace root. Optional; defaults to the workspace root.",
        },
      },
      required: ["subcommand"],
    },
    category: "other",
  },
  {
    name: "search_chat_logs",
    description: stripOneTrailingNewline(searchHistoryDesc),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional keyword or phrase to search for (case-insensitive). Omit this to return messages by time range only.",
        },
        start_time: {
          type: "string",
          description:
            "Optional inclusive lower timestamp bound in RFC3339 format, for example 2026-05-13T09:00:00+10:00.",
        },
        end_time: {
          type: "string",
          description:
            "Optional inclusive upper timestamp bound in RFC3339 format, for example 2026-05-13T17:00:00+10:00.",
        },
        max_results: {
          type: "number",
          description: "Maximum matching messages to return. Defaults to 20, maximum 100.",
        },
        model: {
          type: "string",
          description:
            "Optional model filter: only return assistant messages minted by a matching model. Case-insensitive substring match with '.' and '-' treated as equal, so 'opus-4.6' matches both 'claude-opus-4-6' and 'anthropic/claude-opus-4.6'. Messages stored before model tracking carry no model and never match.",
        },
        excerpt_chars: {
          type: "number",
          description:
            "Approximate excerpt length in characters. Defaults to 360; maximum 2000. Use larger values when you need full quotes rather than context snippets.",
        },
      },
      required: [],
    },
    category: "other",
  },
  {
    name: "model_history",
    description: stripOneTrailingNewline(modelHistoryDesc),
    parameters: {
      type: "object",
      properties: {
        start_time: {
          type: "string",
          description:
            "Optional inclusive lower timestamp bound in RFC3339 format, for example 2026-05-13T09:00:00+10:00.",
        },
        end_time: {
          type: "string",
          description:
            "Optional inclusive upper timestamp bound in RFC3339 format, for example 2026-05-13T17:00:00+10:00.",
        },
      },
      required: [],
    },
    category: "other",
  },
]);

/**
 * Whether allowlist `pattern` matches tool `name`.
 *
 * A trailing `*` is a prefix glob (`mcp__hue__*` matches `mcp__hue__set`); any
 * other pattern is an exact match. This is a deliberate fail-closed whitelist —
 * a new tool a server adds later is not granted until a pattern covers it.
 *
 * Note that `search*` therefore also grants `search_chat_logs`, and a bare `*`
 * grants everything. Both are pinned by the fixture.
 */
export function toolPatternMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

/** Whether `name` is allowed by the enabled-tools allowlist. */
export function toolEnabled(cfg: ToolsConfigView, name: string): boolean {
  return cfg.enabled_tools.some((t) => toolPatternMatches(t, name));
}

/** Whether any tool or sub-agent is offered (i.e. tool use is active). */
export function anyEnabled(cfg: ToolsConfigView): boolean {
  return cfg.enabled_tools.length > 0 || cfg.enabled_subagents.length > 0;
}

/**
 * The tools offered for the `enabled_tools` allowlist, in registry order.
 *
 * Tools are opt-in: only names a pattern covers are offered. Filtering, not
 * selecting — a config listing `["git", "read"]` still offers `read` first,
 * because that is where `read` sits in {@link ALL_TOOLS}.
 */
export function availableTools(cfg: ToolsConfigView): ToolDef[] {
  return ALL_TOOLS.filter((t) => toolEnabled(cfg, t.name));
}

/**
 * The `{{char}}` / `{{user}}` substitutions every tool description is rendered
 * against — the same pipeline the system prompt uses, so a placeholder in a
 * description cannot ship literally to the model.
 */
export function templateVars(charName: string, userName: string): Map<string, string> {
  return new Map([
    ["char", charName],
    ["character_name", charName],
    ["user", userName],
  ]);
}

/**
 * Build the outbound `tools` array from the allowlist, rendering `{{char}}` /
 * `{{user}}` in each description.
 *
 * `renderTemplate` substitutes in a single pass and never re-scans its own
 * output, so a character literally named `{{user}}` renders to the text
 * `{{user}}` rather than recursing into the user's name. That is deliberate —
 * a re-scanning pass makes the cache prefix depend on the character's name in
 * a way that is not stable — and the fixture pins it.
 */
export function renderToolDefs(
  cfg: ToolsConfigView,
  charName: string,
  userName: string,
): ToolDefinition[] {
  const vars = templateVars(charName, userName);
  return availableTools(cfg).map((t) => ({
    name: t.name,
    description: renderTemplate(t.description, vars),
    input_schema: t.parameters,
  }));
}

/**
 * Compare by Unicode code point, which is the order Rust's `BTreeMap<String>`
 * used: it sorts by UTF-8 bytes, and UTF-8 byte order and code-point order
 * agree for every valid scalar.
 *
 * JavaScript's default string comparison does **not** agree. It compares UTF-16
 * code units, so anything outside the BMP — an emoji in a sub-agent name — is
 * a surrogate pair starting at 0xD800 and sorts *below* the 0xE000–0xFFFF
 * range instead of above it. A sub-agent named `🎵drum` and one named `ﬀute`
 * come out in opposite orders under the two rules, which reorders the tool
 * surface and invalidates the cache prefix from that point on.
 */
function compareByCodePoint(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  const shared = Math.min(ac.length, bc.length);
  for (let i = 0; i < shared; i += 1) {
    // Safe: `i < shared <= ac.length`, and every element of a spread string is
    // a non-empty code point, so `codePointAt(0)` is defined.
    const x = (ac[i] as string).codePointAt(0) as number;
    const y = (bc[i] as string).codePointAt(0) as number;
    if (x !== y) return x - y;
  }
  return ac.length - bc.length;
}

/**
 * Synthesize the `ask_<name>` tool defs for the configured sub-agents,
 * rendering `{{char}}` / `{{user}}` in each description.
 *
 * Offered in sub-agent-name order, not `enabled_subagents` order: the Rust
 * iterated a `BTreeMap` and filtered it by the enabled list, so reordering the
 * enabled list in config must not reorder the surface. A name in
 * `enabled_subagents` with no `[subagents.<name>]` entry is silently dropped,
 * and a duplicate entry offers the tool once — both fall out of iterating the
 * config rather than the enabled list, and both are pinned.
 */
export function subagentToolDefs(
  subagents: ReadonlyMap<string, SubagentConfigView>,
  enabled: readonly string[],
  charName: string,
  userName: string,
): ToolDefinition[] {
  const vars = templateVars(charName, userName);
  return [...subagents.keys()]
    .sort(compareByCodePoint)
    .filter((name) => enabled.includes(name))
    .map((name) => ({
      name: `ask_${name}`,
      // Safe: `name` came from `subagents.keys()`.
      description: renderTemplate((subagents.get(name) as SubagentConfigView).description, vars),
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language request for this sub-agent.",
          },
        },
        required: ["query"],
      },
    }));
}

/**
 * Concatenate the tool surface in offer order: static tools, then `ask_<name>`
 * delegation, then MCP.
 *
 * Anthropic caches on a prefix match, so the order the tools are offered in is
 * part of the cache key: appending a newly-enabled sub-agent in the middle
 * would invalidate every downstream block. Each group is internally stable
 * (registry order, sub-agent name order, and the MCP registry's pinned sort),
 * and this is the one place the groups are sequenced.
 *
 * Trivial enough to inline at the call site, which is exactly why it is not:
 * three `concat`s written out twice is how the two callers drift.
 */
export function assembleToolSurface(
  staticDefs: readonly ToolDefinition[],
  subagentDefs: readonly ToolDefinition[],
  mcpDefs: readonly ToolDefinition[],
): ToolDefinition[] {
  return [...staticDefs, ...subagentDefs, ...mcpDefs];
}
