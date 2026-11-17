import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import { characterDataDir } from "../src/config/dirs.ts";
import { findEffectiveModel } from "../src/config/effective_catalog.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { configView } from "../src/config/preferences.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { formatWallClock } from "../src/engine/prompt.ts";
import { NO_PRIOR_CONTEXT } from "../src/engine/segments.ts";
import type { Message } from "../src/engine/types.ts";
import { buildChatShapeRequestFromDisk } from "../src/handler/context.ts";
import { hostZone } from "../src/ledger/zoned.ts";
import { testTmp } from "./support/tmp.ts";

const KEY_ENV = "SHORE_CONTEXT_TEST_KEY";
const AT = Date.UTC(2026, 9, 30, 12);

function said(text: string): Message {
  return { msg_id: "m_1", role: "user", content: text, images: [], content_blocks: [{ type: "text", text }], alternatives: [], timestamp: new Date(AT).toISOString() };
}

async function world(): Promise<{ workspace: string; sent: (messages: Message[], options?: { activeConversation?: boolean; timeZone?: string }) => Promise<string> }> {
  const root = await mkdtemp(testTmp("shore-context-"));
  const app = defaultAppConfig();
  app.chat.model = "fixture";
  app.chat.user_timestamps = "always";
  app.tools.enabled = [];
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV, maxContextTokens: 200_000, maxOutputTokens: 4096,
  });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const resolved = findEffectiveModel(configView(config), config.dirs.cache, "fixture", true);
  return {
    workspace: join(config.dirs.config, "characters", "ada", "workspace"),
    sent: async (messages, options = {}) => JSON.stringify((await buildChatShapeRequestFromDisk(
      "ada", characterDataDir(config.dirs.data, "ada"), config, resolved, messages, NO_PRIOR_CONTEXT, { ...options, env: { [KEY_ENV]: "key" } },
    )).request),
  };
}

test("a conversation under way keeps the workspace files it started with, and one with nothing in it yet starts from them as they are now", async () => {
  const { workspace, sent } = await world();
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada, first draft.");
  const hello = said("hello");
  expect(await sent([hello])).toContain("Ada, first draft.");

  await writeFile(join(workspace, "SOUL.md"), "Ada, second draft.");
  expect(await sent([hello])).toContain("Ada, first draft.");
  expect(await sent([], { activeConversation: true })).toContain("Ada, first draft.");
  expect(await sent([])).toContain("Ada, second draft.");
  expect(await sent([hello])).toContain("Ada, second draft.");

  await writeFile(join(workspace, "SOUL.md"), "Ada, third draft.");
  expect(await sent([hello], { activeConversation: false })).toContain("Ada, third draft.");
});

test("a fresh conversation sets the workspace up, with the default tool notes, before reading it", async () => {
  const { workspace, sent } = await world();
  await sent([]);
  expect((await readFile(join(workspace, "TOOLS.md"), "utf8")).length).toBeGreaterThan(0);
});

test("the times on the user's messages are given in the zone asked for", async () => {
  const { sent } = await world();
  const zone = hostZone() === "Pacific/Chatham" ? "Asia/Kolkata" : "Pacific/Chatham";
  const shown = await sent([said("hello")], { timeZone: zone });
  expect(shown).toContain(formatWallClock(AT, zone));
  expect(shown).not.toContain(formatWallClock(AT, hostZone()));
});
