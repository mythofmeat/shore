import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runToolUse, type ToolExecution } from "../../src/tools/execute.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../../src/tools/workspace.ts";
import type { ServerMessage } from "../../src/protocol/ServerMessage.ts";

const root = await mkdtemp(join(tmpdir(), "shore-read-preview-"));
try {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await writeFile(join(root, "chart.png"), Buffer.from(png, "base64"));
  const markdown = process.argv.includes("markdown");
  if (markdown) {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n\n![Chart](../chart.png)\n");
  }
  const call = { id: "read-1", name: "read", input: { file_path: markdown ? "docs/guide.md" : "chart.png" } };
  const live: ServerMessage[] = [];
  const exec: ToolExecution = {
    ctx: {
      workspaceDir: root, characterName: "Ada", characterDataDir: root, imageDir: "",
      conversationDir: root, historyDbPath: join(root, "history.db"), configDir: root,
      searchConfig: { api_key_env: "UNUSED", result_limit: 5, search_depth: "basic", include_answer: false },
      retrievalConfig: DEFAULT_RETRIEVAL_CONFIG, retrievalMode: "auto",
    },
    sendDirect: (frame) => { live.push(frame); },
    limits: { max_result_chars: 50_000, timeout_ms: 5000 },
    now: () => "2026-09-21", newMessageId: () => "reply-1",
  };
  const result = await runToolUse(call, exec, []);
  if (result.isError) throw new Error(result.raw);
  console.log(JSON.stringify({
    live,
    history: { type: "history", messages: [{
      msg_id: "reply-1", role: "assistant", content: "", images: [], timestamp: "",
      content_blocks: [{ type: "tool_use", ...call }, result.block],
    }] },
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
