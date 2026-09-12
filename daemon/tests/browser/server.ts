import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/run.ts";
import type { SidecarProvider } from "../../src/llm/types.ts";

const root = await mkdtemp(join(tmpdir(), "shore-gui-test-"));
await mkdir(join(root, "config"));
const configPath = join(root, "config", "shore.toml");
const oldKey = process.env["SHORE_BROWSER_DISCOVERY_KEY"];
process.env["SHORE_BROWSER_DISCOVERY_KEY"] = "private-discovery-fixture-key";
const discovery = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (request.headers.get("authorization") !== "Bearer private-discovery-fixture-key") return new Response("Wrong fixture key", { status: 401 });
  if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [
    { id: "vendor/visible", name: "Visible test model", context_length: 64000, max_output_tokens: 4096, supported_parameters: ["tools", "reasoning"] },
    { id: "vendor/hidden", name: "Hidden test model" },
  ] });
  return new Response("Fixture discovery unavailable", { status: 503 });
} });
await writeFile(configPath, `[defaults]
model = "anthropic:claude-opus-4-8"
[providers.anthropic]
api_key_env = "SHORE_BROWSER_KEY"
[providers.anthropic.discovery]
enabled = false
[providers.fixture]
sdk = "openai"
base_url = "${discovery.url.href}v1"
api_key_env = "SHORE_BROWSER_DISCOVERY_KEY"
[providers.fixture.discovery]
enabled = true
ignore = ["vendor/hidden"]
[providers.broken]
sdk = "openai"
base_url = "${discovery.url.href}broken"
api_key_env = "SHORE_BROWSER_DISCOVERY_KEY"
[providers.broken.discovery]
enabled = true
[providers.off]
enabled = false
[daemon.web]
enabled = true
bind_addr = "127.0.0.1:${process.env["SHORE_BROWSER_TEST_PORT"] ?? "17349"}"
`);
let generation = 0;
const provider: SidecarProvider = {
  async *stream(request, signal) {
    generation += 1;
    const question = request.messages.findLast((message) => message.role === "user")?.content.filter((block) => block.type === "text").map((block) => block.text).join(" ") ?? "";
    yield { type: "start", model: request.model };
    yield { type: "thinking", text: "Considering the question" };
    if (question.includes("hold this request")) {
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return;
    }
    const text = `Answer ${String(generation)}: ${question}`;
    yield { type: "text", text };
    yield { type: "done", content: text, finish_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
  },
  generate() { throw new Error("Browser fixture requires streaming"); },
};

try {
  const daemon = await startDaemon({ argv: ["--config", configPath, "--addr", "127.0.0.1:0"], env: {
    XDG_CONFIG_HOME: join(root, "config-home"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "runtime"),
    SHORE_TOKEN: "browser-test-token", SHORE_BROWSER_KEY: "test-key",
  }, providers: { anthropic: provider }, instancesPath: join(root, "instances.json"), watchConfig: false, autoDiscovery: false });
  process.once("SIGTERM", () => { daemon.stop(); });
  process.once("SIGINT", () => { daemon.stop(); });
  await daemon.done;
} finally {
  await discovery.stop(true);
  if (oldKey === undefined) delete process.env["SHORE_BROWSER_DISCOVERY_KEY"]; else process.env["SHORE_BROWSER_DISCOVERY_KEY"] = oldKey;
  await rm(root, { recursive: true, force: true });
}
