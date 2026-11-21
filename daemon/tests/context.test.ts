import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PromptPart } from "../src/config/app.ts";
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
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";

const KEY_ENV = "SHORE_CONTEXT_TEST_KEY";
const AT = Date.UTC(2026, 9, 30, 12);

function said(text: string): Message {
  return { msg_id: "m_1", role: "user", content: text, images: [], content_blocks: [{ type: "text", text }], alternatives: [], timestamp: new Date(AT).toISOString() };
}

interface World {
  configDir: string;
  workspace: string;
  sent: (messages: Message[], options?: { activeConversation?: boolean; timeZone?: string }) => Promise<string>;
  system: () => Promise<string[]>;
}

async function world(prompt?: PromptPart[]): Promise<World> {
  const root = await mkdtemp(testTmp("shore-context-"));
  const app = promptedAppConfig();
  if (prompt !== undefined) app.prompt = prompt;
  app.chat.model = "fixture";
  app.chat.user_timestamps = "always";
  app.chat.display_name = "eve";
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
  const built = async (messages: Message[], options = {}) => (await buildChatShapeRequestFromDisk(
    "ada", characterDataDir(config.dirs.data, "ada"), config, resolved, messages, NO_PRIOR_CONTEXT, { ...options, env: { [KEY_ENV]: "key" } },
  )).request;
  return {
    configDir: config.dirs.config,
    workspace: join(config.dirs.config, "characters", "ada", "workspace"),
    sent: async (messages, options = {}) => JSON.stringify(await built(messages, options)),
    system: async () => ((await built([said("hello")])).system ?? []).map((block) => block.text),
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

test("the system prompt is the listed parts in the listed order: config files as templates, and workspace files under any name as written", async () => {
  const { configDir, workspace, system } = await world([
    { workspace: "notes/MAP.md" },
    { file: "prompts/opening.md" },
    { workspace: "SOUL.md" },
    { file: "prompts/closing.md" },
    { workspace: "absent.md" },
  ]);
  await mkdir(join(configDir, "prompts"), { recursive: true });
  await writeFile(join(configDir, "prompts", "opening.md"), "You are {{char}}, with {{user}}.");
  await writeFile(join(configDir, "prompts", "closing.md"), "That is all.");
  await mkdir(join(workspace, "notes"), { recursive: true });
  await writeFile(join(workspace, "notes", "MAP.md"), "- {{char}}'s places");
  await writeFile(join(workspace, "SOUL.md"), "Ada.");

  expect(await system()).toEqual(["- {{char}}'s places", "You are ada, with eve.", "Ada.", "That is all."]);
  expect((await readdir(workspace)).sort()).toEqual(["SOUL.md", "notes"]);
});

test("a listed config file that can't be read stops the request and names the path", async () => {
  const { configDir, system } = await world([{ file: "prompts/gone.md" }]);
  expect(await outcomeOf(system())).toThrow(`prompt file "prompts/gone.md" could not be read at ${join(configDir, "prompts", "gone.md")}`);
});

test("a config with no prompt list stops the request rather than sending no system prompt", async () => {
  const { system } = await world([]);
  expect(await outcomeOf(system())).toThrow("the config has no [[prompt]] list");
});

test("the system_prompt part is the model's system_prompt file, and is left out when none is set", async () => {
  const { configDir, system } = await world([{ shore: "system_prompt" }, { file: "after.md" }]);
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "after.md"), "After.");
  expect(await system()).toEqual(["After."]);
});

test("the times on the user's messages are given in the zone asked for", async () => {
  const { sent } = await world();
  const zone = hostZone() === "Pacific/Chatham" ? "Asia/Kolkata" : "Pacific/Chatham";
  const shown = await sent([said("hello")], { timeZone: zone });
  expect(shown).toContain(formatWallClock(AT, zone));
  expect(shown).not.toContain(formatWallClock(AT, hostZone()));
});
