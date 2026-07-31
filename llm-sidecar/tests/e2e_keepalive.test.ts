/**
 * End-to-end: the prompt-cache keepalive across the real seam.
 *
 *   shore-daemon  ──llm.sock──>  shore-llm-sidecar  ──HTTP──>  fake Anthropic
 *
 * The unit tests on either side each mock the other, so a disagreement between
 * the two real implementations cannot turn one red. That is the whole risk of
 * this move: the schedule, the clock, and the ping now live in a different
 * process from the conversation they protect, joined by four hand-written JSON
 * bodies that nothing else checks.
 *
 * What this asserts, in order of how expensive getting it wrong would be:
 *
 *   1. A ping actually fires, unprompted, with no user in the loop.
 *   2. Its body is byte-identical to the turn it stands in for, everywhere the
 *      Anthropic cache prefix is computed from. A divergence here does not fail
 *      anything — it silently converts a 0.1x read into a 2.0x write, forever.
 *   3. It is recorded as a `keepalive` row, so `shore usage` and the cache
 *      tracker see it.
 *   4. What happened comes back to the daemon: the heartbeat log gets the line,
 *      and the schedule reaches the state file so a restart can re-arm.
 *
 * The cadence is squeezed to a couple of seconds via `cache_keepalive`, so the
 * sidecar's 10s tick is what sets the pace of this test.
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

interface Block {
  type?: string;
  text?: string;
}
interface SentBody {
  messages?: Array<{ role: string; content: Block[] | string }>;
  system?: unknown;
  tools?: unknown;
  model?: string;
  max_tokens?: number;
  stream?: boolean;
}

/** One `calls` row, as the sidecar wrote it. */
interface LedgerRow {
  call_type: string;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface Persisted {
  keepalive_model?: string | null;
  keepalive_interval_ms?: number | null;
  keepalive_last_warm_at?: string | null;
  keepalive_last_active_at?: string | null;
}

interface Run {
  /** Every request body the fake Anthropic received, in order. */
  sent: SentBody[];
  ledger: LedgerRow[];
  /** `autonomy_state.json` for the character, after the daemon persisted it. */
  persisted: Persisted;
  /** Heartbeat log lines. */
  heartbeat: Array<{ kind?: string; detail?: string }>;
}

/** One assistant turn as the SSE frames the Anthropic SDK's parser expects. */
function sse(text: string): string {
  const f = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    f("message_start", {
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
    }) +
    f("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    f("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }) +
    f("content_block_stop", { type: "content_block_stop", index: 0 }) +
    f("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    }) +
    f("message_stop", { type: "message_stop" })
  );
}

/**
 * Boot daemon + sidecar, send one message, then idle long enough for the
 * keepalive to fire on its own.
 *
 * `pingRead` is what the fake reports for the ping's `cache_read_input_tokens`.
 * Zero (with a write) is the cold case the subsystem disarms on.
 */
async function run(opts: { cadence: string; idleMs: number; pingRead: number }): Promise<Run> {
  const root = `/tmp/shore-e2e-ka-${Math.random().toString(36).slice(2, 8)}`;
  const [CONFIG, DATA, CACHE, RUNTIME] = [
    `${root}/config`,
    `${root}/data`,
    `${root}/cache`,
    `${root}/run`,
  ];

  const sent: SentBody[] = [];
  const anthropic = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as SentBody;
      sent.push(body);
      // The keepalive ping is non-streaming (`/v1/generate`); a chat turn is
      // SSE. That split is itself part of what this exercises.
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
            cache_read_input_tokens: opts.pingRead,
            cache_creation_input_tokens: opts.pingRead === 0 ? 2100 : 0,
          },
        });
      }
      return new Response(sse("Hello there."), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const port = 7900 + Math.floor(Math.random() * 400);
  const ws = `${CONFIG}/characters/${CHAR}/workspace`;
  for (const d of [CONFIG, DATA, CACHE, RUNTIME, ws]) sh(["mkdir", "-p", d]);
  await Bun.write(
    `${CONFIG}/config.toml`,
    `[defaults]\nmodel = "anthropic:claude-opus-4-8"\n\n` +
      `[providers.anthropic]\napi_key_env = "FAKE_ANTHROPIC_KEY"\n` +
      `base_url = "http://127.0.0.1:${anthropic.port}/v1"\n\n` +
      // The cadence is a `ModelConfigFields` knob, and `[providers.*.defaults]`
      // is the same field bag applied provider-wide — which is the reachable
      // one from config.toml.
      `[providers.anthropic.defaults]\ncache_keepalive = "${opts.cadence}"\n\n` +
      `[daemon]\naddr = "127.0.0.1:${port}"\n`,
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
        client_name: "e2e-keepalive",
        capabilities: ["streaming"],
        character: CHAR,
      })}\n`,
    );
    await sleep(400);

    conn.write(`${JSON.stringify({ type: "message", rid: "p0", text: "hello", stream: true })}\n`);
    const d = Date.now() + 40000;
    while (!done && Date.now() < d) await sleep(200);
    await sleep(1200);

    // Now go quiet. Nothing else touches the daemon: any further request to the
    // fake Anthropic came from the keepalive deciding to send one.
    await sleep(opts.idleMs);
    conn.end();
    // One more tick so the daemon drains what the sidecar did and persists it.
    await sleep(12_000);

    const db = openLedger(`${DATA}/ledger.db`, { readonly: true });
    const ledger = db
      .query(
        "SELECT call_type, cache_read_tokens, cache_write_tokens FROM calls ORDER BY id ASC",
      )
      .all() as LedgerRow[];
    db.close();

    const statePath = `${DATA}/${CHAR}/autonomy_state.json`;
    const persisted = (await Bun.file(statePath).exists())
      ? ((await Bun.file(statePath).json()) as Persisted)
      : {};

    const hbPath = `${DATA}/${CHAR}/heartbeat.jsonl`;
    const heartbeat = (await Bun.file(hbPath).exists())
      ? (await Bun.file(hbPath).text())
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as { kind?: string; detail?: string })
      : [];

    return { sent, ledger, persisted, heartbeat };
  } finally {
    stop();
  }
}

const have = (p: string) => Bun.spawnSync(["test", "-x", p]).exitCode === 0;
const ready = have(DAEMON) && have(SIDECAR);

/** The blocks of a message, whichever shape the adapter sent it in. */
function blocksOf(content: Block[] | string): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

describe.skipIf(!ready)("cache keepalive, end to end", () => {
  test(
    "a ping fires unprompted, matches the cached prefix, and reports back",
    async () => {
      const { sent, ledger, persisted, heartbeat } = await run({
        cadence: "2s",
        idleMs: 25_000,
        pingRead: 2200,
      });

      // -- 1. it fired at all ------------------------------------------------
      const chat = sent.filter((b) => b.stream);
      const pings = sent.filter((b) => !b.stream);
      expect(chat.length, "the one user turn").toBe(1);
      expect(
        pings.length,
        "the keepalive sent at least one ping with nobody driving it",
      ).toBeGreaterThan(0);

      // -- 2. the ping body matches the turn it stands in for ----------------
      // This is the assertion the whole subsystem rests on. Everything the
      // Anthropic cache prefix is computed from — model, tools, system, and the
      // leading messages — must be identical, or the ping pays a full write
      // instead of a read and is worse than useless.
      const turn = chat[0]!;
      const ping = pings[0]!;
      expect(ping.model).toEqual(turn.model);
      expect(ping.system).toEqual(turn.system);
      expect(ping.tools).toEqual(turn.tools);

      const turnMsgs = turn.messages ?? [];
      const pingMsgs = ping.messages ?? [];
      // The ping carries the turn's messages, plus the assistant reply the
      // daemon appended when it cached the prefix, plus the trailing ".".
      expect(pingMsgs.length).toBeGreaterThan(turnMsgs.length);
      expect(pingMsgs.slice(0, turnMsgs.length)).toEqual(turnMsgs);
      expect(ping.max_tokens, "a ping generates nothing").toBe(1);

      const tail = pingMsgs.at(-1)!;
      expect(tail.role).toBe("user");
      expect(blocksOf(tail.content)[0]?.text).toBe(".");

      // The reply between them is the assistant turn, so the body is exactly
      // "the conversation as it stands, plus a nudge".
      const beforeTail = pingMsgs[pingMsgs.length - 2]!;
      expect(beforeTail.role).toBe("assistant");
      expect(blocksOf(beforeTail.content).some((b) => b.text === "Hello there.")).toBe(true);

      // -- 3. it is on the books as a keepalive ------------------------------
      const keepaliveRows = ledger.filter((r) => r.call_type === "keepalive");
      expect(keepaliveRows.length, "`shore usage` sees the ping").toBeGreaterThan(0);
      expect(keepaliveRows[0]!.cache_read_tokens).toBe(2200);
      expect(keepaliveRows[0]!.cache_write_tokens).toBe(0);

      // -- 4. the daemon got it back -----------------------------------------
      // The sidecar clears events on drain, so a line here proves the round
      // trip: sidecar fired it, daemon collected it, daemon wrote it down.
      const pingLines = heartbeat.filter((e) => (e.detail ?? "").includes("Cache refresh ping"));
      expect(pingLines.length, "the heartbeat log records the ping").toBeGreaterThan(0);

      // And the schedule reached the state file, which is what a restart
      // offers back to `/v1/keepalive/restore`.
      expect(persisted.keepalive_model).toBe("claude-opus-4-8");
      expect(persisted.keepalive_interval_ms, "milliseconds, not truncated seconds").toBe(2000);
      expect(persisted.keepalive_last_warm_at).toBeTruthy();
      expect(persisted.keepalive_last_active_at).toBeTruthy();
    },
    120_000,
  );

  test(
    "a cold ping disarms and says so, instead of buying another write",
    async () => {
      // Read 0 and paid a write: the prefix was already gone, so this ping
      // recreated it at full price rather than refreshing it. The schedule must
      // stand down — retrying only buys another guaranteed write — and the
      // persisted copy must be cleared so a restart does not re-arm it.
      const { sent, ledger, persisted, heartbeat } = await run({
        cadence: "2s",
        idleMs: 25_000,
        pingRead: 0,
      });

      const pings = sent.filter((b) => !b.stream);
      expect(pings.length, "exactly one — the cold read disarms it").toBe(1);

      const keepaliveRows = ledger.filter((r) => r.call_type === "keepalive");
      expect(keepaliveRows).toHaveLength(1);
      expect(keepaliveRows[0]!.cache_read_tokens).toBe(0);
      expect(keepaliveRows[0]!.cache_write_tokens).toBe(2100);

      const cold = heartbeat.filter((e) => (e.detail ?? "").includes("COLD"));
      expect(cold.length, "the log names it as cold").toBeGreaterThan(0);

      expect(persisted.keepalive_model, "nothing left to restore").toBeFalsy();
    },
    120_000,
  );
});
