import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { createRuntime, startRuntimeClocks, type ShoreRuntime } from "../src/runtime.ts";

const MODEL = process.argv[2] ?? "claude-haiku-4-5";
const KEY_ENV = "SHORE_HEARTBEAT_PROBE_KEY";
const PING_INTERVAL_SECS = 4 * 60;

async function loadApiKey(): Promise<string> {
  const fromEnv = process.env["ANTHROPIC_API_KEY"];
  if (fromEnv) return fromEnv;
  const dir = process.env["SHORE_CONFIG_DIR"] ?? join(homedir(), ".config", "shore");
  const envPath = join(dir, ".env");
  for (const line of (await readFile(envPath, "utf8")).split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY=(.*)$/);
    if (m) return (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(`ANTHROPIC_API_KEY not in process env or ${envPath}`);
}

function soul(): string {
  const lines = ["You are Ada, a calm and curious companion who keeps a quiet journal of small observations."];
  for (let i = 1; i <= 120; i += 1) {
    lines.push(
      `Note ${i}: Ada remembers that the garden path number ${i} curves past a stone bench, ` +
        `that the light there shifts from amber to grey as evening comes, and that visitors ` +
        `who stop at bench ${i} usually ask about the old sundial and the herbs beside it.`,
    );
  }
  return lines.join("\n");
}

interface Row {
  call_type: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

function rowsOf(runtime: ShoreRuntime): Row[] {
  return (runtime.callStore?.database
    .query("SELECT call_type, input_tokens, cache_read_tokens, cache_write_tokens FROM calls ORDER BY id")
    .all() ?? []) as Row[];
}

const root = await mkdtemp(join(tmpdir(), "shore-heartbeat-probe-"));
const app = defaultAppConfig();
app.defaults.model = "probe";
app.advanced.max_retries = 0;
app.memory.compaction.enabled = false;
app.tools.enabled_tools = [];
app.behavior.autonomy.enabled = true;
const models = emptyCatalog();
models.chat.set("chat.probe", {
  name: "probe", qualifiedName: "chat.probe", category: "chat", providerKey: "anthropic",
  sdk: "anthropic", modelId: MODEL, apiKeyEnv: KEY_ENV,
  maxContextTokens: 200_000, maxOutputTokens: 1024, maxToolIterations: 3,
  cacheTtl: "5m",
  cacheKeepalive: { kind: "every", interval: ConfigDuration.fromSecs(PING_INTERVAL_SECS) },
  cacheKeepalivePings: 1,
});
const config: LoadedConfig = {
  app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
  dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
};
const workspace = join(config.dirs.config, "characters", "ada", "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "SOUL.md"), soul());

const env = { [KEY_ENV]: await loadApiKey() };
const runtime = await createRuntime({ config, providers: { anthropic: new AnthropicProvider() }, env });
const clocks = startRuntimeClocks(runtime);
let refreshed = false;
try {
  const autonomy = new TurnAutonomyBridge(runtime.autonomy);
  const deps = buildGenerationDeps({
    runtime, providers: runtime.providers, autonomy, diagnostics: new Diagnostics(), env, emitEvent: () => {},
  });
  await runGeneration(deps, {
    meta: {
      session: {
        sessionId: 1, clientId: 1, clientType: "probe", clientName: "probe", capabilities: [],
        selectedCharacter: "ada", selectedThread: "main",
      },
      rid: "chat", kind: "message",
    },
    body: {
      rid: "chat", text: "Hello Ada. Which bench do you like best? One short sentence, please.",
      stream: true, images: [], image_data: [],
    },
    charName: "ada", regen: false, rid: "chat", signal: new AbortController().signal, send: async () => {},
  });
  await autonomy.settled("ada");
  const chatRows = rowsOf(runtime);
  const lastChatCall = chatRows.filter((row) => row.call_type === "message" || row.call_type === "tool_loop").at(-1);
  if (lastChatCall === undefined) throw new Error("the chat turn recorded no call");
  const armed = lastChatCall.cache_read_tokens + lastChatCall.cache_write_tokens;
  const pingAfterChat = runtime.keepalive.nextPingAt("ada");

  if (runtime.autonomy.forceHeartbeatNow("ada") === undefined) throw new Error("the heartbeat could not be forced");
  await runtime.autonomy.tick();
  const pingAfterHeartbeat = runtime.keepalive.nextPingAt("ada");
  const heartbeatRows = rowsOf(runtime).slice(chatRows.length);
  const roundZero = heartbeatRows.find((row) => row.call_type === "heartbeat");
  if (roundZero === undefined) throw new Error("the heartbeat recorded no first round");

  const ping = await runtime.keepalive.pingNow("ada");
  const moved = pingAfterChat !== undefined && pingAfterHeartbeat !== undefined && pingAfterHeartbeat > pingAfterChat;
  refreshed = armed > 0 && roundZero.cache_read_tokens >= armed && moved;
  console.log(JSON.stringify({
    model: MODEL,
    chat_calls: chatRows,
    armed_prefix_tokens: armed,
    heartbeat_calls: heartbeatRows,
    heartbeat_round_zero_read: roundZero.cache_read_tokens,
    ping_moved_by_ms: moved ? pingAfterHeartbeat - pingAfterChat : 0,
    schedule: runtime.keepalive.scheduleFor("ada"),
    ping_now: { status: ping.status, cold: ping.cold, usage: ping.usage, detail: ping.detail },
    heartbeat_refreshed_chat_entry: refreshed,
  }, null, 1));
} finally {
  clocks.stop();
  await runtime.autonomy.shutdown();
  await runtime.shutdown();
  await rm(root, { recursive: true, force: true });
}
if (!refreshed) process.exit(1);
