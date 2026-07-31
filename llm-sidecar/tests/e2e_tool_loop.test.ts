/**
 * End-to-end: a real daemon, a real sidecar, and a fake Anthropic.
 *
 *   shore-daemon  ──llm.sock──>  shore-llm-sidecar  ──HTTP/SSE──>  fake Anthropic
 *        ^                              │
 *        └────────  tool socket  ───────┘
 *
 * Every other test of this path puts a real implementation of one side against
 * a hand-written fake of the other, so a disagreement between the two real
 * implementations cannot produce a red test. This one runs both, and asserts on
 * what the daemon actually wrote to `active.jsonl`.
 *
 * The first scripted turn asks for TWO tools in one round. That is the case
 * that separates per-round bookkeeping from per-call bookkeeping, and it is
 * where the daemon-driven loop and the sidecar-driven loop diverge.
 *
 * Requires both binaries; skips if either is missing:
 *   cargo build -p shore-daemon && (cd llm-sidecar && bun run build)
 */

import { describe, expect, test } from "bun:test";
import { openLedger } from "./support/ledger_fixture.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const DAEMON = `${ROOT}/target/debug/shore-daemon`;
const SIDECAR = `${ROOT}/llm-sidecar/dist/shore-llm-sidecar`;
const CHAR = "probe";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });

type Turn =
  | { kind: "tools"; text: string; tools: Array<{ id: string; name: string; input: unknown }> }
  | { kind: "text"; text: string };

/** One turn as the SSE frames the Anthropic SDK's parser expects. */
function sse(turn: Turn): string {
  const f = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = f("message_start", {
    type: "message_start",
    message: {
      id: "msg_probe",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  let i = 0;
  out += f("content_block_start", {
    type: "content_block_start",
    index: i,
    content_block: { type: "text", text: "" },
  });
  out += f("content_block_delta", {
    type: "content_block_delta",
    index: i,
    delta: { type: "text_delta", text: turn.text },
  });
  out += f("content_block_stop", { type: "content_block_stop", index: i });
  i++;
  if (turn.kind === "tools") {
    for (const t of turn.tools) {
      out += f("content_block_start", {
        type: "content_block_start",
        index: i,
        content_block: { type: "tool_use", id: t.id, name: t.name, input: {} },
      });
      out += f("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) },
      });
      out += f("content_block_stop", { type: "content_block_stop", index: i });
      i++;
    }
  }
  out += f("message_delta", {
    type: "message_delta",
    delta: { stop_reason: turn.kind === "tools" ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 12 },
  });
  out += f("message_stop", { type: "message_stop" });
  return out;
}

interface Block {
  type?: string;
  id?: string;
  tool_use_id?: string;
  text?: string;
}
interface StoredMessage {
  role?: string;
  content_blocks?: Block[];
}

/** One usage-ledger row, as `record_call` wrote it. */
interface LedgerRow {
  call_type: string;
  cache_read_tokens: number;
  cache_write_tokens: number;
  input_tokens: number;
}

interface Run {
  stored: StoredMessage[];
  /** Usage-ledger rows, oldest first. Not the call store `call_log` reads —
   *  that records one entry per HTTP request to the sidecar, so a whole
   *  delegated loop is one entry there no matter how many calls it made. */
  ledger: LedgerRow[];
  /** Message arrays as they were sent to the provider, per call. */
  sent: Array<Array<{ role: string; content: Block[] }>>;
  /** Command replies, in the order the commands were sent. */
  replies: Array<Record<string, unknown>>;
}

/** Boot a daemon + sidecar against a scripted fake Anthropic, send `turns` prompts. */
async function run(script: Turn[], prompts: string[], commands: string[] = []): Promise<Run> {
  const root = `/tmp/shore-e2e-${Math.random().toString(36).slice(2, 8)}`;
  const [CONFIG, DATA, CACHE, RUNTIME] = [
    `${root}/config`,
    `${root}/data`,
    `${root}/cache`,
    `${root}/run`,
  ];

  const sent: Run["sent"] = [];
  let next = 0;
  const anthropic = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content: Block[] }>;
        stream?: boolean;
      };
      sent.push(body.messages ?? []);
      // The keepalive ping is non-streaming (`/v1/generate`), so it needs a
      // plain message back rather than SSE frames.
      if (!body.stream) {
        return Response.json({
          id: "msg_ping",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 0,
          },
        });
      }
      return new Response(sse(script[next++] ?? { kind: "text", text: "(exhausted)" }), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const port = 7400 + Math.floor(Math.random() * 500);
  const ws = `${CONFIG}/characters/${CHAR}/workspace`;
  for (const d of [CONFIG, DATA, CACHE, RUNTIME, ws]) sh(["mkdir", "-p", d]);
  await Bun.write(
    `${CONFIG}/config.toml`,
    `[defaults]\nmodel = "anthropic:claude-opus-4-8"\n\n` +
      `[providers.anthropic]\napi_key_env = "FAKE_ANTHROPIC_KEY"\n` +
      `base_url = "http://127.0.0.1:${anthropic.port}/v1"\n\n` +
      `[daemon]\naddr = "127.0.0.1:${port}"\n\n[tools]\nenabled_tools = ["roll_dice"]\n`,
  );
  await Bun.write(`${ws}/SOUL.md`, "You are a probe.\n");
  sh(["git", "-C", ws, "init", "-q"]);
  sh(["git", "-C", ws, "add", "-A"]);
  sh(["git", "-C", ws, "-c", "user.email=a@b.c", "-c", "user.name=p", "commit", "-qm", "i"]);

  const daemon = Bun.spawn([DAEMON], {
    env: {
      ...process.env,
      SHORE_CONFIG_DIR: CONFIG,
      SHORE_DATA_DIR: DATA,
      SHORE_CACHE_DIR: CACHE,
      SHORE_RUNTIME_DIR: RUNTIME,
      SHORE_LLM_SIDECAR_BIN: SIDECAR,
      FAKE_ANTHROPIC_KEY: "sk-fake",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const stop = () => {
    daemon.kill();
    anthropic.stop(true);
    sh(["rm", "-rf", root]);
  };

  try {
    const deadline = Date.now() + 30000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        const probe = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
        probe.end();
        up = true;
      } catch {
        await sleep(200);
      }
    }
    if (!up) throw new Error("daemon never listened");
    await sleep(1500); // sidecar supervisor

    let buf = "";
    let done = false;
    const replies: Array<Record<string, unknown>> = [];
    const conn = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(_s, chunk) {
          buf += new TextDecoder().decode(chunk);
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            try {
              const m = JSON.parse(line) as Record<string, unknown>;
              if (m["type"] === "stream_end" && m["is_final"] !== false) done = true;
              if (m["type"] === "command_output") {
                replies.push(m);
                done = true;
              }
              if (m["type"] === "error") {
                replies.push(m);
                done = true;
              }
            } catch {
              /* partial frame */
            }
          }
        },
      },
    });
    conn.write(
      `${JSON.stringify({
        type: "hello",
        client_type: "tui",
        client_name: "e2e",
        capabilities: ["streaming"],
        character: CHAR,
      })}\n`,
    );
    await sleep(400);

    for (const [n, prompt] of prompts.entries()) {
      done = false;
      conn.write(`${JSON.stringify({ type: "message", rid: `p${n}`, text: prompt, stream: true })}\n`);
      const d = Date.now() + 40000;
      while (!done && Date.now() < d) await sleep(200);
      await sleep(1200);
    }

    for (const [n, name] of commands.entries()) {
      done = false;
      conn.write(`${JSON.stringify({ type: "command", rid: `c${n}`, name, args: {} })}\n`);
      const d = Date.now() + 30000;
      while (!done && Date.now() < d) await sleep(200);
    }
    conn.end();

    const text = await Bun.file(`${DATA}/${CHAR}/active.jsonl`).text();
    const stored = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as StoredMessage);

    const db = openLedger(`${DATA}/ledger.db`, { readonly: true });
    const ledger = db
      .query(
        "SELECT call_type, cache_read_tokens, cache_write_tokens, input_tokens \
         FROM calls ORDER BY id ASC",
      )
      .all() as LedgerRow[];
    db.close();

    return { stored, sent, replies, ledger };
  } finally {
    stop();
  }
}

const have = (p: string) => Bun.spawnSync(["test", "-x", p]).exitCode === 0;
const ready = have(DAEMON) && have(SIDECAR);

const blocksOf = (m: StoredMessage) => m.content_blocks ?? [];
const idsIn = (ms: StoredMessage[], type: "tool_use" | "tool_result") =>
  ms.flatMap((m) =>
    blocksOf(m)
      .filter((b) => b.type === type)
      .map((b) => String(type === "tool_use" ? b.id : b.tool_use_id)),
  );

describe.skipIf(!ready)("delegated tool loop, end to end", () => {
  const TWO_THEN_ONE: Turn[] = [
    {
      kind: "tools",
      text: "Rolling twice.",
      tools: [
        { id: "toolu_A", name: "roll_dice", input: { notation: "1d6" } },
        { id: "toolu_B", name: "roll_dice", input: { notation: "1d20" } },
      ],
    },
    { kind: "tools", text: "Once more.", tools: [{ id: "toolu_C", name: "roll_dice", input: { notation: "2d4" } }] },
    { kind: "text", text: "All done." },
  ];

  test(
    "a round asking for two tools stores one result message holding both",
    async () => {
      const { stored } = await run(TWO_THEN_ONE, ["roll some dice"]);
      const resultMsgs = stored.filter((m) => blocksOf(m).some((b) => b.type === "tool_result"));

      // Round 1 asked for A and B together; their results belong to one user
      // message, in the order the model asked for them. Splitting them makes
      // the stored order depend on which tool finished first.
      const firstRound = resultMsgs[0];
      expect(firstRound).toBeDefined();
      const ids = blocksOf(firstRound!)
        .filter((b) => b.type === "tool_result")
        .map((b) => String(b.tool_use_id));
      expect(ids).toEqual(["toolu_A", "toolu_B"]);
      expect(resultMsgs.length).toBe(2); // one per round, not one per tool
    },
    90_000,
  );

  test(
    "the ledger gets one row per provider call, not one per loop",
    async () => {
      const { ledger } = await run(TWO_THEN_ONE, ["roll some dice"]);

      // Three scripted turns is three provider calls. Summed into one row they
      // report a `cache_read` no single call made; that becomes the daemon's
      // cache-tracker baseline, and the next ordinary message then reads
      // "less" than it and is flagged `unexpected_write` on a healthy cache.
      expect(ledger.map((r) => r.call_type)).toEqual(["message", "tool_loop", "tool_loop"]);
      // Each row carries its own call's usage, not the loop's total.
      expect(ledger.map((r) => r.input_tokens)).toEqual([20, 20, 20]);
    },
    90_000,
  );

  test(
    "no tool_use id is stored twice",
    async () => {
      const { stored } = await run(TWO_THEN_ONE, ["roll some dice"]);
      const ids = idsIn(stored, "tool_use");
      expect(ids).toEqual([...new Set(ids)]);
    },
    90_000,
  );

  test(
    "every stored tool_use has exactly one matching tool_result",
    async () => {
      const { stored } = await run(TWO_THEN_ONE, ["roll some dice"]);
      expect(idsIn(stored, "tool_use").sort()).toEqual(idsIn(stored, "tool_result").sort());
    },
    90_000,
  );

  test(
    "the stored response is the terminal turn, once",
    async () => {
      const { stored } = await run(TWO_THEN_ONE, ["roll some dice"]);
      const last = stored.at(-1);
      expect(last?.role).toBe("assistant");
      // Not the whole loop replayed, and not the closing text twice — the
      // daemon's accumulator collects every turn and also flushes its own
      // pending text, so both failures are one block-list away from each other.
      expect(blocksOf(last!).map((b) => b.type)).toEqual(["text"]);
      expect(blocksOf(last!)[0]?.text).toBe("All done.");
    },
    90_000,
  );

  test(
    "the keepalive ping replays the conversation the loop actually sent",
    async () => {
      // `last_request` is what the keepalive, heartbeat, dreaming and
      // compaction all clone, and it has to stay byte-identical to what went
      // out or the ping's cache anchors miss and it rewrites the whole prefix
      // at full price (756a308f). The sidecar grows the conversation during a
      // loop and the daemon's copy of the request does not, so the daemon is
      // told what was appended and applies it.
      const { sent, replies } = await run(TWO_THEN_ONE, ["roll some dice"], ["keepalive_ping_now"]);

      const lastTurn = sent[2]; // the loop's final request
      const ping = sent.at(-1); // the keepalive
      expect(lastTurn).toBeDefined();
      expect(ping).toBeDefined();

      // The ping is the loop's final request, unchanged, plus the terminal
      // assistant reply that request produced, plus the ping's own trailing
      // user turn. Any divergence in the shared prefix means it is pinging
      // bytes that were never cached.
      const shape = (ms: Array<{ role: string; content: Block[] }>) =>
        ms.map((m) => `${m.role}:${(m.content ?? []).map((b) => b.type).join("+")}`);
      expect(shape(ping!).slice(0, lastTurn!.length)).toEqual(shape(lastTurn!));
      expect(shape(ping!).slice(lastTurn!.length)).toEqual(["assistant:text", "user:text"]);

      // Specifically: the tool exchanges are in there. Rebuilt without them —
      // which is what the daemon sent before it was told what the loop
      // appended — the prefix diverges at the first tool round.
      expect(shape(ping!)).toContain("assistant:text+tool_use+tool_use");
      expect(shape(ping!)).toContain("user:tool_result+tool_result");

      const reply = replies.at(-1) as { data?: { status?: string } } | undefined;
      expect(reply?.data?.status).toBe("warm");
    },
    120_000,
  );

  test(
    "a follow-up turn sends no duplicate tool_use ids to the provider",
    async () => {
      const { sent } = await run([...TWO_THEN_ONE, { kind: "text", text: "again." }], [
        "roll some dice",
        "again",
      ]);
      const followUp = sent[3];
      expect(followUp).toBeDefined();
      const ids = followUp!.flatMap((m) =>
        (Array.isArray(m.content) ? m.content : [])
          .filter((b) => b.type === "tool_use")
          .map((b) => String(b.id)),
      );
      expect(ids).toEqual([...new Set(ids)]);
    },
    120_000,
  );
});
