import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CommandDeps, CommandSession } from "../src/commands/dispatch.ts";
import { statusContext } from "../src/commands/status_context.ts";
import { loadConfig } from "../src/config/loader.ts";
import type { ConversationEngine } from "../src/engine/conversation.ts";
import type { Message } from "../src/engine/types.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

async function sessionOn(modelId: string): Promise<CommandSession> {
  const root = testTmp(`status-context-${modelId}`);
  const configPath = join(root, "config", "config.toml");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `[chat]\nmodel = "${modelId}"\n\n[chat."anthropic:${modelId}"]\nsdk = "anthropic"\n`);
  const env = {
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: join(root, "data-home"),
    XDG_CACHE_HOME: join(root, "cache-home"),
    XDG_RUNTIME_DIR: join(root, "run-home"),
  };
  return { config: loadConfig(configPath, { env, onWarn: () => {} }), configPath } as CommandSession;
}

test("the status line counts a picture at what the active model is charged for it", async () => {
  const data = (await sizedImage(1920, 1080)).toString("base64");
  const picture: Message = {
    msg_id: "u1",
    role: "user",
    content: "",
    images: [],
    content_blocks: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
    timestamp: "2026-09-30T00:00:00Z",
  };
  const engine = {
    thread: "main",
    characterName: "Tester",
    turnCount: () => 1,
    messages: () => [picture],
    startedAt: () => undefined,
  } as unknown as ConversationEngine;
  const counted = async (modelId: string) =>
    statusContext(engine, await sessionOn(modelId), {} as CommandDeps).contextTokens;
  expect(await counted("claude-haiku-4-5")).toBe(1560);
  expect(await counted("claude-opus-5-5")).toBe(2691);
});
