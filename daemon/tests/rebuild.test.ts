import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { rebuildRequestFromDisk, wakeRebuildMessages } from "../src/cache/rebuild.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { MessageStore, serializeMessages } from "../src/engine/message_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { shoreLog } from "../src/log.ts";
import { NO_MCP } from "./support/rebuild.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";
import { testTmp } from "./support/tmp.ts";

const KEY_ENV = "SHORE_REBUILD_TEST_KEY";
const T0 = Date.UTC(2026, 9, 30, 12);

function said(id: string, role: Message["role"], blocks: ContentBlock[] | string, minutes: number, extra: Partial<Message> = {}): Message {
  const content_blocks: ContentBlock[] = typeof blocks === "string" ? [{ type: "text", text: blocks }] : blocks;
  return {
    msg_id: id, role, images: [], content_blocks, alternatives: [],
    content: content_blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    timestamp: new Date(T0 + minutes * 60_000).toISOString(), ...extra,
  };
}

const call: ContentBlock = { type: "tool_use", id: "t1", name: "read", input: {} };
const result: ContentBlock = { type: "tool_result", tool_use_id: "t1", content: "done" };
const ANCHOR = said("anchor", "user", "[anchor]", 0);

test("a rebuild keeps a conversation that is between turns, opens one with no user turn with the idle line, and skips one in the middle of a turn", () => {
  const anchor = (): Message => ANCHOR;
  const hello = said("u1", "user", "hello", 1);
  const reply = said("a1", "assistant", "hi", 2);
  const woke = said("w1", "assistant", "I looked around.", 3, { origin: "autonomous" });
  const looked = said("w0", "assistant", [call], 2, { origin: "autonomous" });
  const answered = said("r0", "user", [result], 2);
  expect(wakeRebuildMessages("ada", [hello, reply], anchor)).toEqual([hello, reply]);
  expect(wakeRebuildMessages("ada", [hello], anchor)).toBeUndefined();
  expect(wakeRebuildMessages("ada", [], anchor)).toEqual([ANCHOR]);
  expect(wakeRebuildMessages("ada", [woke], anchor)).toEqual([ANCHOR, woke]);
  expect(wakeRebuildMessages("ada", [looked, answered, woke], anchor)).toEqual([ANCHOR, looked, answered, woke]);
  expect(wakeRebuildMessages("ada", [answered], anchor)).toBeUndefined();
});

async function world(withModel = true): Promise<{ config: LoadedConfig; data: string; workspace: string; conversation: (messages: Message[]) => void }> {
  const root = await mkdtemp(testTmp("shore-rebuild-"));
  const app = promptedAppConfig();
  app.chat.user_timestamps = "always";
  app.chat.display_name = "eve";
  app.tools.enabled = [];
  const models = emptyCatalog();
  if (withModel) {
    app.chat.model = "fixture";
    models.chat.set("chat.fixture", {
      name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
      sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV, maxContextTokens: 200_000, maxOutputTokens: 4096,
    } as unknown as ResolvedModel);
  }
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(config.dirs.data, "ada", "threads", "main"), { recursive: true });
  return {
    config, data: config.dirs.data, workspace,
    conversation: (messages) => { writeDurable(threadFile(config.dirs.data, "ada", "main", "active.jsonl"), serializeMessages(messages)); },
  };
}

const rebuilt = async (config: LoadedConfig, timeZone?: string): Promise<SidecarRequest | undefined> =>
  (await rebuildRequestFromDisk("ada", config.dirs.data, config, { ...NO_MCP, thread: "main", env: { [KEY_ENV]: "key" }, ...(timeZone === undefined ? {} : { timeZone }) }))?.request;

const system = (request: SidecarRequest | undefined): string => (request?.system ?? []).map((block) => block.text).join("\n");

test("a rebuilt request holds the prompt as the conversation started while one is going on, and the workspace's files as they are once it is empty", async () => {
  const { config, workspace, conversation } = await world();
  await writeFile(join(workspace, "SOUL.md"), "Ada, as she was.");
  conversation([said("w1", "assistant", "I looked around.", 3, { origin: "autonomous" })]);
  expect(system(await rebuilt(config))).toContain("Ada, as she was.");
  await writeFile(join(workspace, "SOUL.md"), "Ada, as she is.");
  expect(system(await rebuilt(config))).toContain("Ada, as she was.");
  conversation([]);
  expect(system(await rebuilt(config))).toContain("Ada, as she is.");
});

test("a rebuilt request opens a conversation with no user turn with the idle line, in the user's wording when they gave one, and tells the time in the zone it is given", async () => {
  const { config, conversation } = await world();
  conversation([said("u1", "user", "hello", 1), said("a1", "assistant", "hi", 2)]);
  const first = (request: SidecarRequest | undefined): string | undefined => request?.messages[0]?.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
  expect(first(await rebuilt(config, "Pacific/Kiritimati"))).toBe("[Saturday 2026-10-31 · 2:01 AM]\n\nhello");
  expect(first(await rebuilt(config, "UTC"))).toBe("[Friday 2026-10-30 · 12:01 PM]\n\nhello");
  conversation([]);
  expect(first(await rebuilt(config))?.split("\n\n").at(-1)).toBe("[Resuming after an extended idle period — the earlier conversation has been archived to memory.]");
  await writeFile(join(config.dirs.config, "idle.md"), "[back after a while]\n");
  expect(first(await rebuilt({ ...config, app: { ...config.app, texts: { idle_resume: "idle.md" } } }))?.split("\n\n").at(-1)).toBe("[back after a while]");
});

test("nothing is rebuilt from a conversation that can't be read, one in the middle of a turn, or for a character with no chat model", async () => {
  const unread = await world();
  const failing = spyOn(MessageStore, "load").mockRejectedValueOnce(new Error("disk on fire"));
  try {
    expect(await rebuilt(unread.config)).toBeUndefined();
  } finally {
    failing.mockRestore();
  }
  const midTurn = await world();
  midTurn.conversation([said("u1", "user", "hello", 1)]);
  const modelless = await world(false);
  modelless.conversation([said("u1", "user", "hello", 1), said("a1", "assistant", "hi", 2)]);
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    expect([await rebuilt(midTurn.config), await rebuilt(modelless.config)]).toEqual([undefined, undefined]);
    expect(warned).not.toHaveBeenCalled();
  } finally {
    warned.mockRestore();
  }
});
