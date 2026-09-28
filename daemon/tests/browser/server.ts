import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/run.ts";
import type { SidecarProvider } from "../../src/llm/types.ts";
import { seedDiagnosticFixture } from "../support/diagnostic_fixture.ts";
import { restoreTestEnv, setTestEnv } from "../support/env.ts";
import { cacheFixture, compactionFixture, seedArchivedSegment } from "../support/memory_fixture.ts";
import { toolFixture } from "../support/tool_fixture.ts";
import { seedUsageFixture, USAGE_FIXTURE_CONFIG } from "../support/usage_fixture.ts";

const root = await mkdtemp(join(tmpdir(), "shore-gui-test-"));
await mkdir(join(root, "config"));
const configPath = join(root, "config", "shore.toml");
setTestEnv("SHORE_BROWSER_DISCOVERY_KEY", "private-discovery-fixture-key");
const discovery = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (request.headers.get("authorization") !== "Bearer private-discovery-fixture-key") return new Response("Wrong fixture key", { status: 401 });
  if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [
    { id: "vendor/visible", name: "Visible test model", context_length: 64000, max_output_tokens: 4096, supported_parameters: ["tools", "reasoning"] },
    { id: "vendor/hidden", name: "Hidden test model" },
  ] });
  return new Response("Fixture discovery unavailable", { status: 503 });
} });
await writeFile(configPath, `[chat]
model = "anthropic:claude-opus-4-8"
[tools]
enabled = ${JSON.stringify(process.env["SHORE_BROWSER_MEDIA_FIXTURE"] === "true" ? ["bash", "read", "mcp__tool_fixture__three_images"] : ["bash"])}
[tools.bash]
max_result_chars = 1024
[mcp.tool_fixture]
command = ${JSON.stringify(process.execPath)}
args = ["run", ${JSON.stringify(join(import.meta.dir, "../support/mcp_tool_fixture.ts"))}]
[chat."anthropic:fast-fixture"]
max_output_tokens = 4096
[chat."openrouter:vendor-fixture"]
max_output_tokens = 4096
[subagents]
enabled = ["worker"]
[subagents.worker]
description = "Local browser test worker"
prompt = "You are a test worker."
model = "anthropic:fast-fixture"
tools = ["bash"]
[providers.anthropic]
api_key_env = "SHORE_BROWSER_KEY"
discover = false
[providers.fixture]
sdk = "openai"
base_url = "${discovery.url.href}v1"
api_key_env = "SHORE_BROWSER_DISCOVERY_KEY"
discover = true
ignore_models = ["vendor/hidden"]
[providers.broken]
sdk = "openai"
base_url = "${discovery.url.href}broken"
api_key_env = "SHORE_BROWSER_DISCOVERY_KEY"
discover = true
[providers.off]
enabled = false
[daemon.web]
enabled = true
bind_addr = ${JSON.stringify(process.env["SHORE_BROWSER_WEB_BIND"] ?? "127.0.0.1:0")}
${process.env["SHORE_BROWSER_USAGE_SEED"] === "true" ? USAGE_FIXTURE_CONFIG : ""}
${process.env["SHORE_BROWSER_CALM_BUDGET"] === "true" ? '[[budgets]]\nname = "Quiet"\nperiod = "month"\ncost_usd = 10\nwarn_fractions = [0.5]\ncharacter = "quiet"\n' : ""}
`);
let generation = 0;
const answered = new Set<string>();
const cleanup = new AbortController();
const memoryStream = compactionFixture(cleanup.signal);
const provider: SidecarProvider = {
  async *stream(request, signal) {
    if (request.context?.call_type === "compaction") { yield* memoryStream(request, signal); return; }
    if (request.context?.call_type === "subagent") { yield* toolFixture(request, signal); return; }
    generation += 1;
    const question = request.messages.findLast((message) => message.role === "user")?.content.filter((block) => block.type === "text").map((block) => block.text).join(" ") ?? "";
    if (question.includes("fail this reply")) throw Object.assign(new Error("Fixture reply failure"), { status: 400 });
    yield { type: "start", model: request.model };
    yield { type: "thinking", text: "Considering the question" };
    if (question.includes("long live preview fixture")) {
      yield { type: "text", text: "x".repeat(1024 * 1024) + "LIVE_PREVIEW_TAIL" };
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return;
    }
    const omittedImages = request.messages.at(-1)?.content.some((block) => block.type === "tool_result" && block.tool_use_id === "omitted-images") === true;
    if (question.includes("show omitted image fixture") || omittedImages) {
      if (!omittedImages) {
        yield { type: "tool_use", id: "omitted-images", name: "mcp__tool_fixture__three_images", input: {} };
        yield { type: "done", content: "", finish_reason: "tool_use", usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
      } else {
        yield { type: "text", text: "Three original images returned; only two went to the model." };
        yield { type: "done", content: "Three original images returned; only two went to the model.", finish_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
      }
      return;
    }
    const galleryRead = request.messages.at(-1)?.content.some((block) => block.type === "tool_result" && block.tool_use_id === "gallery-read-image") === true;
    if (question.includes("show gallery image fixture") || galleryRead) {
      if (!galleryRead) {
        yield { type: "tool_use", id: "gallery-read-image", name: "read", input: { file_path: "tool-image.png" } };
        yield { type: "done", content: "", finish_reason: "tool_use", usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
      } else {
        yield { type: "text", text: "Tool image ready" };
        await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      }
      return;
    }
    if (question.includes("run worker display fixture")) {
      yield { type: "tool_use", id: "display-worker", name: "ask_worker", input: { query: "Inspect the tool fixture" } };
      yield { type: "done", content: "", finish_reason: "tool_use", usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
      return;
    }
    if (question.includes("hold regenerations") && answered.has(question)) {
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return;
    }
    answered.add(question);
    if (question.includes("hold this request")) {
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return;
    }
    const text = `Answer ${String(generation)}: ${question}`;
    yield { type: "text", text };
    yield { type: "done", content: text, finish_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
  },
  generate: cacheFixture,
};

try {
  const daemon = await startDaemon({ argv: ["--config", configPath, "--addr", "127.0.0.1:0"], env: {
    XDG_CONFIG_HOME: join(root, "config-home"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "runtime"),
    SHORE_TOKEN: "browser-test-token", SHORE_BROWSER_KEY: "test-key",
  }, providers: { anthropic: provider }, instancesPath: join(root, "instances.json"), watchConfig: false, autoDiscovery: false });
  await seedDiagnosticFixture(daemon.runtime, "nova");
  if (process.env["SHORE_BROWSER_USAGE_SEED"] === "true") await seedUsageFixture(daemon.runtime);
  seedArchivedSegment(daemon.runtime, "recovery");
  process.once("SIGTERM", () => { cleanup.abort(); daemon.stop(); });
  process.once("SIGINT", () => { cleanup.abort(); daemon.stop(); });
  if (daemon.web === undefined) throw new Error("Browser fixture did not start its web listener");
  console.log(`SHORE_BROWSER_READY ${daemon.web.origin} ${String(daemon.port)}`);
  await daemon.done;
} finally {
  await discovery.stop(true);
  restoreTestEnv();
  await rm(root, { recursive: true, force: true });
}
