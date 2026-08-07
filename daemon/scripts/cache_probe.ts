/**
 * Live cache-behavior probe for `replay_prior_thinking` (#191), Sonnet only.
 *
 * Drives multi-turn conversations against the real Anthropic API through the
 * production `buildAnthropicParams` (so the #191 trailing-marker placement is
 * the actual code under test), mirroring the daemon's upstream thinking-strip
 * for each replay mode. Records per-turn `cache_creation` / `cache_read` so we
 * can quantify the per-turn cache bust `last_turn` introduces and confirm the
 * trailing marker contains it (no unexpected invalidation).
 *
 * Run from daemon/:  bun run scripts/cache_probe.ts
 *
 * NOT a unit test — it spends real Anthropic credits.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildAnthropicParams } from "../src/llm/providers/anthropic.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";
import type { ContentBlock } from "../src/engine/types.ts";

const MODEL = "claude-sonnet-4-5";
const TURNS = 6; // turn 0 = warm-up (expect creation), turn 1 = read-confirm, 2+ = steady state
const BUDGET_TOKENS = 4096;
const MAX_TOKENS = 8192;

type Mode = "all" | "last_turn" | "none";
type Shape = "plain" | "tool_loop";

// `all` and `none` are append-only-stable and already proven in prod, so the
// live test focuses on the only new behavior: `last_turn`'s moving boundary,
// run over an IDENTICAL captured transcript with the trailing marker both on
// and off — the controlled comparison that attributes any cache difference to
// the marker rather than to per-conversation thinking-size variance.

// ── env / client ─────────────────────────────────────────────────────────────

/** Resolve the key from the process env first, then the shore config dir's
 * `.env` (`$SHORE_CONFIG_DIR` or `~/.config/shore`). */
function loadApiKey(): string {
  const fromEnv = process.env["ANTHROPIC_API_KEY"];
  if (fromEnv) return fromEnv;
  const dir = process.env["SHORE_CONFIG_DIR"] ?? join(homedir(), ".config", "shore");
  const envPath = join(dir, ".env");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY=(.*)$/);
    if (m) return (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(`ANTHROPIC_API_KEY not in process env or ${envPath}`);
}

// ── large, stable system prompt with a per-cell nonce ─────────────────────────

function buildSystem(nonce: string): NonNullable<SidecarRequest["system"]> {
  // ~6k tokens, well above Sonnet's 2048 cache floor, so every breakpoint
  // (system + all message anchors) clears the minimum from turn 0. The nonce
  // sits at the top so this cell's cached prefix never collides with another
  // run's cache entries.
  const para =
    "You are a meticulous research assistant operating under a strict caching " +
    "evaluation harness. For EVERY question you must reason extensively and " +
    "exhaustively in your private thinking: enumerate assumptions, work through " +
    "multiple solution approaches step by step, double-check the arithmetic, and " +
    "only then give a single concise final sentence. Do not skip the reasoning " +
    "even if the answer seems obvious. Maintain consistent terminology across " +
    "turns so that the conversational prefix remains byte-stable. ";
  const filler = Array.from({ length: 95 }, (_, i) => `[guideline ${i + 1}] ${para}`).join("\n");
  return [
    { type: "text" as const, text: `CACHE-PROBE-NONCE: ${nonce}\n\n${filler}`, _label: "system_base" },
  ];
}

// ── thinking-strip (mirrors the daemon's content_util.rs, applied upstream) ───

function isThinking(b: ContentBlock): boolean {
  return b.type === "thinking" || b.type === "redacted_thinking";
}
function isToolResultOnlyUser(m: WireMessage): boolean {
  return (
    m.role === "user" &&
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every((b) => b.type === "tool_result")
  );
}
function stripThinking(m: WireMessage): void {
  if (m.role === "assistant" && Array.isArray(m.content)) {
    m.content = m.content.filter((b) => !isThinking(b));
  }
}
/** Index where the most-recent assistant turn begins within `msgs[0..len]`. */
function mostRecentTurnStart(msgs: WireMessage[], len: number): number {
  let lastA = -1;
  for (let i = len - 1; i >= 0; i--) {
    if (msgs[i]?.role === "assistant") {
      lastA = i;
      break;
    }
  }
  if (lastA < 0) return len;
  let start = lastA;
  while (start > 0) {
    const prev = msgs[start - 1];
    if (prev && (prev.role === "assistant" || isToolResultOnlyUser(prev))) start -= 1;
    else break;
  }
  return start;
}

/**
 * Apply the mode's strip to the COMPLETED history `[0, completedLen)`, leaving
 * the in-progress turn `[completedLen, ...]` untouched (its thinking is
 * required by the API mid-tool-loop and is always replayed in production).
 * Returns a deep-cloned message array safe to mutate.
 */
function applyStrip(history: WireMessage[], mode: Mode, completedLen: number): WireMessage[] {
  const out: WireMessage[] = JSON.parse(JSON.stringify(history));
  if (mode === "all") return out;
  const keepFrom = mode === "last_turn" ? mostRecentTurnStart(out, completedLen) : completedLen;
  for (let i = 0; i < completedLen; i++) {
    if (i < keepFrom || mode === "none") stripThinking(out[i]!);
  }
  return out;
}

// ── Anthropic response → our ContentBlock[] ───────────────────────────────────

function toBlocks(content: Anthropic.ContentBlock[]): ContentBlock[] {
  return content.map((b): ContentBlock => {
    switch (b.type) {
      case "thinking":
        return { type: "thinking", thinking: b.thinking, signature: b.signature };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: b.data };
      case "text":
        return { type: "text", text: b.text };
      case "tool_use":
        return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      default:
        return { type: "text", text: "" };
    }
  });
}

const TOOL = [
  {
    name: "lookup_fact",
    description:
      "Look up a short fact about a topic. You MUST call this tool exactly once before answering each user question.",
    input_schema: {
      type: "object",
      properties: { topic: { type: "string", description: "topic to look up" } },
      required: ["topic"],
    },
  },
];

interface Usage {
  input_tokens: number;
  cache_creation: number;
  cache_read: number;
}
interface Row extends Usage {
  turn: number;
  step: string;
}

// ── one API call through the production param builder ─────────────────────────

async function call(
  client: Anthropic,
  system: NonNullable<SidecarRequest["system"]>,
  history: WireMessage[],
  completedLen: number,
  mode: Mode,
  shape: Shape,
): Promise<{ usage: Usage; content: ContentBlock[] }> {
  const messages = applyStrip(history, mode, completedLen);
  const req: SidecarRequest = {
    sdk: "anthropic" as SidecarRequest["sdk"],
    model: MODEL,
    api_key: "", // client carries the key; params builder doesn't need it
    messages,
    system,
    max_tokens: MAX_TOKENS,
    provider_options: { cache_ttl: "1h", budget_tokens: BUDGET_TOKENS },
    ...(shape === "tool_loop" ? { tools: TOOL } : {}),
  };
  const params = buildAnthropicParams(req);
  const resp = (await client.messages.create({
    ...(params as unknown as Anthropic.MessageCreateParamsNonStreaming),
    stream: false,
  })) as Anthropic.Message;
  const u = resp.usage;
  return {
    usage: {
      input_tokens: u.input_tokens ?? 0,
      cache_creation: u.cache_creation_input_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
    },
    content: toBlocks(resp.content),
  };
}

// ── drive one cell ────────────────────────────────────────────────────────────

// Reasoning-heavy prompts so each turn produces a substantial thinking block
// — that is what makes the moving boundary (and the marker) actually matter.
const PROMPTS = [
  "Two trains start 360 miles apart heading toward each other; one at 50 mph, the other at 70 mph. Reason step by step about exactly when and where they meet.",
  "Now suppose the faster train pauses for 20 minutes exactly when it has covered a third of its initial distance to the meeting point. Re-derive when they meet.",
  "A tank fills via pipe A in 6 hours and B in 9 hours, but drain C empties it in 12 hours. With all three open, reason carefully about how long to fill it.",
  "If 3 painters paint 3 fences in 3 hours, reason through how long 9 painters take to paint 9 fences, and explain why the intuitive answer is a trap.",
  "You have 12 identical-looking coins, one counterfeit (lighter). Reason through a 3-weighing balance strategy that always finds it.",
  "Compound interest: $1000 at 5% annual, compounded monthly vs annually over 3 years. Reason through both and quantify the difference.",
];

// A replayable transcript so marker on/off run over IDENTICAL content (the only
// way to attribute a `create`/`read` difference to the marker rather than to
// nondeterministic per-conversation thinking sizes). `completedLen` is the
// history length at the turn's start (prior turns = completed history; the rest
// is the in-progress turn whose thinking is always kept).
type Event =
  | { kind: "append"; msg: WireMessage }
  | { kind: "measure"; label: string; turn: number; completedLen: number };

/** Run the conversation live with the marker ON, recording both the marker-on
 * rows and a replayable script of the exact messages/measure-points. */
async function captureRun(
  client: Anthropic,
  shape: Shape,
): Promise<{ rows: Row[]; script: Event[] }> {
  process.env["SHORE_ANTHROPIC_TURN_MARKER"] = "1";
  const system = buildSystem(randomUUID());
  const history: WireMessage[] = [];
  const rows: Row[] = [];
  const script: Event[] = [];
  const push = (msg: WireMessage) => {
    history.push(msg);
    script.push({ kind: "append", msg });
  };

  for (let turn = 0; turn < TURNS; turn++) {
    const completedLen = history.length;
    push({ role: "user", content: [{ type: "text", text: PROMPTS[turn % PROMPTS.length]! }] });

    let r = await call(client, system, history, completedLen, "last_turn", shape);
    rows.push({ turn, step: "init", ...r.usage });
    script.push({ kind: "measure", label: "init", turn, completedLen });
    push({ role: "assistant", content: r.content });

    if (shape === "tool_loop") {
      const tu = r.content.find((b) => b.type === "tool_use");
      if (tu && tu.type === "tool_use") {
        push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: tu.id, content: "A concise factual answer." }],
        });
        r = await call(client, system, history, completedLen, "last_turn", shape);
        rows.push({ turn, step: "post_tool", ...r.usage });
        script.push({ kind: "measure", label: "post_tool", turn, completedLen });
        push({ role: "assistant", content: r.content });
      }
    }
  }
  return { rows, script };
}

/** Replay the captured script with the marker OFF (fresh nonce), measuring at
 * the same points over identical message content. */
async function replayRun(client: Anthropic, shape: Shape, script: Event[]): Promise<Row[]> {
  process.env["SHORE_ANTHROPIC_TURN_MARKER"] = "0";
  const system = buildSystem(randomUUID());
  const history: WireMessage[] = [];
  const rows: Row[] = [];
  for (const ev of script) {
    if (ev.kind === "append") {
      history.push(JSON.parse(JSON.stringify(ev.msg)) as WireMessage);
    } else {
      const r = await call(client, system, history, ev.completedLen, "last_turn", shape);
      rows.push({ turn: ev.turn, step: ev.label, ...r.usage });
    }
  }
  return rows;
}

// ── main ──────────────────────────────────────────────────────────────────────

function printTable(label: string, rows: Row[]): void {
  process.stderr.write(`\n=== ${label} ===\n`);
  for (const r of rows) {
    const total = r.input_tokens + r.cache_creation + r.cache_read;
    const readPct = total > 0 ? Math.round((r.cache_read / total) * 100) : 0;
    process.stderr.write(
      `  t${r.turn} ${r.step.padEnd(10)} in=${String(r.input_tokens).padStart(6)} ` +
        `create=${String(r.cache_creation).padStart(6)} read=${String(r.cache_read).padStart(6)} ` +
        `read%=${String(readPct).padStart(3)} total=${String(total).padStart(6)}\n`,
    );
  }
}

async function main() {
  const client = new Anthropic({ apiKey: loadApiKey(), maxRetries: 2 });
  const shapes: Shape[] = ["plain", "tool_loop"];
  const results: Array<{ shape: Shape; markerOn: Row[]; markerOff: Row[] }> = [];

  for (const shape of shapes) {
    const cap = await captureRun(client, shape); // marker ON, captures transcript
    printTable(`${shape} marker=ON`, cap.rows);
    const off = await replayRun(client, shape, cap.script); // marker OFF, identical content
    printTable(`${shape} marker=OFF (same transcript)`, off);

    // Side-by-side create delta at each measure point (off - on); >0 = marker saved writes.
    process.stderr.write(`  --- ${shape}: create(off) - create(on), identical content ---\n`);
    for (let i = 0; i < cap.rows.length; i++) {
      const on = cap.rows[i]!;
      const o = off[i]!;
      process.stderr.write(
        `  t${on.turn} ${on.step.padEnd(10)} on=${String(on.cache_creation).padStart(6)} ` +
          `off=${String(o.cache_creation).padStart(6)} Δ=${String(o.cache_creation - on.cache_creation).padStart(6)}\n`,
      );
    }
    results.push({ shape, markerOn: cap.rows, markerOff: off });
  }

  console.log(JSON.stringify({ model: MODEL, turns: TURNS, results }, null, 2));
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e?.stack ?? e}\n`);
  process.exit(1);
});
