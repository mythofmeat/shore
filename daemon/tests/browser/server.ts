import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/run.ts";
import type { SidecarProvider } from "../../src/llm/types.ts";

const root = await mkdtemp(join(tmpdir(), "shore-gui-test-"));
await mkdir(join(root, "config"));
const configPath = join(root, "config", "shore.toml");
await writeFile(configPath, `[defaults]\nmodel = "anthropic:claude-opus-4-8"\n[providers.anthropic]\napi_key_env = "SHORE_BROWSER_KEY"\n[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:${process.env["SHORE_BROWSER_TEST_PORT"] ?? "17349"}"\n`);
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
  }, providers: { anthropic: provider }, instancesPath: join(root, "instances.json"), watchConfig: false });
  process.once("SIGTERM", () => { daemon.stop(); });
  process.once("SIGINT", () => { daemon.stop(); });
  await daemon.done;
} finally { await rm(root, { recursive: true, force: true }); }
