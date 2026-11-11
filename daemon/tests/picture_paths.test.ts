import { expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { characterCacheDir } from "../src/config/dirs.ts";
import { loadConfig } from "../src/config/loader.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { ingestImages } from "../src/handler/images.ts";
import { buildLlmMessages } from "../src/handler/wire_messages.ts";
import { toolResultText } from "../src/llm/types.ts";
import { shoreLog } from "../src/log.ts";
import { evictCachedImages } from "../src/storage/image_cache.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { carryToolMedia } from "../src/tools/media.ts";
import { closePictureFolder, openPictureFolder, sharePictureFolders } from "../src/tools/picture_access.ts";
import { noisePng } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";

async function world() {
  const root = testTmp(`picture-paths-${crypto.randomUUID()}`);
  const data = join(root, "data");
  const cache = join(root, "cache");
  const workspaceDir = join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(data, { recursive: true });
  const ctx: ToolContext = {
    workspaceDir, characterName: "ada", characterDataDir: join(data, "ada"), imageDir: join(root, "media"), cacheDir: cache,
    conversationDir: join(data, "ada", "threads", "main"), historyDbPath: join(data, "shore.db"), configDir: root,
  };
  const exec: ToolExecution = {
    ctx, sendDirect: () => {},
    limits: { max_result_chars: 50_000, timeout_ms: 5000 },
    now: () => "2026-11-12T10:00:00+11:00", newMessageId: () => crypto.randomUUID(),
  };
  const run = async (name: string, input: unknown) => {
    const result = await runToolUse({ id: crypto.randomUUID(), name, input }, exec, []);
    const block = result.block as Extract<ContentBlock, { type: "tool_result" }>;
    return { isError: result.isError, text: toolResultText(block.content) };
  };
  const send = async (png: Buffer): Promise<Message> => {
    const { images } = await ingestImages(cache, "ada", ["cat.png"], [{ filename: "cat.png", data: png.toString("base64") }]);
    return {
      msg_id: crypto.randomUUID(), role: "user", content: "look", images,
      content_blocks: [{ type: "text", text: "look" }], timestamp: "2026-11-12T09:00:00+11:00",
    };
  };
  return { root, cache, workspaceDir, ctx, run, send };
}

async function shownAs(message: Message): Promise<string[]> {
  const { messages } = await buildLlmMessages({ system: [], messages: [message] }, "text_standin");
  return (messages[0]?.content ?? []).map((block) => block.type === "text" ? block.text : block.type);
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o7777;
}

test("a picture the user sent is shown with the path of its file, which a command can copy until the file is evicted", async () => {
  const { cache, workspaceDir, run, send } = await world();
  const png = Buffer.from(await noisePng(4, 4, 7));
  const message = await send(png);
  const file = message.images[0]?.path ?? "";

  expect(await shownAs(message)).toEqual([`[picture: ${file}]`, "image", "look"]);
  expect(await run("bash", { command: `mkdir keep && cp '${file}' keep/cat.png` })).toMatchObject({ isError: false });
  expect(await readFile(join(workspaceDir, "keep", "cat.png"))).toEqual(png);

  evictCachedImages(cache, 0, Date.now() + 2 * 60 * 60 * 1000);
  const evicted = await shownAs(message);
  expect(evicted).toHaveLength(2);
  expect(evicted[0]).toContain("no longer cached");
  expect(evicted.join("\n")).not.toContain(file);
});

test("a picture a tool returns with no file of its own says where its copy is kept, and one read from a file does not", async () => {
  const { cache, workspaceDir, ctx, run } = await world();
  const png = Buffer.from(await noisePng(4, 4, 11));
  ctx.mcpCall = () => Promise.resolve(carryToolMedia({ value: "captured", media: [{ mime_type: "image/png", data: png.toString("base64"), label: "screenshot" }], extra: [] }));
  await writeFile(join(workspaceDir, "drawing.png"), png);

  const captured = await run("mcp__browser__screenshot", {});
  const file = /\[screenshot attached; its file is (.+)\]/.exec(captured.text)?.[1] ?? "";
  expect(dirname(file)).toBe(join(characterCacheDir(cache, "ada"), "images", "tools"));
  expect(await readFile(file)).toEqual(png);

  const read = await run("read", { file_path: "drawing.png" });
  expect(read.text).toEndWith(`[${join(workspaceDir, "drawing.png")} attached]`);
});

test("a character's cache folder is the daemon's alone, and its tools' user may pass through to the pictures only while it has one", async () => {
  const cache = join(testTmp(`picture-access-${crypto.randomUUID()}`), "cache");
  mkdirSync(join(characterCacheDir(cache, "bea"), "images"), { recursive: true });
  chmodSync(cache, 0o700);
  const gid = process.getgroups?.().find((group) => group !== process.getgid?.()) ?? process.getgid?.() ?? 0;

  expect(openPictureFolder(cache, "ada", gid)).toBe(join(characterCacheDir(cache, "ada"), "images"));

  const folder = characterCacheDir(cache, "ada");
  expect([modeOf(folder), statSync(folder).gid]).toEqual([0o710, gid]);
  expect([modeOf(cache), modeOf(dirname(folder))]).toEqual([0o710, modeOf(characterCacheDir(cache, "bea")) | 0o010]);
  expect(statSync(join(folder, "images")).isDirectory()).toBe(true);

  closePictureFolder(cache, "ada");
  closePictureFolder(cache, "nobody");
  expect(modeOf(folder)).toBe(0o700);
  expect(statSync(characterCacheDir(cache, "nobody"), { throwIfNoEntry: false })).toBeUndefined();
});

test("starting up closes every character's cache folder, and says so when a tools user cannot be given its pictures", async () => {
  const root = testTmp(`picture-sharing-${crypto.randomUUID()}`);
  const cache = join(root, "cache");
  await mkdir(join(root, "characters", "bea"), { recursive: true });
  await writeFile(join(root, "config.toml"), "");
  await writeFile(join(root, "characters", "bea", "config.toml"), '[tools]\nuser = "shore-no-such-user"\n');
  for (const name of ["ada", "bea"]) mkdirSync(join(characterCacheDir(cache, name), "images"), { recursive: true });
  chmodSync(cache, 0o700);
  const config = loadConfig(join(root, "config.toml"), {
    env: { SHORE_CONFIG_DIR: root, SHORE_DATA_DIR: join(root, "data"), SHORE_CACHE_DIR: cache },
    onWarn: () => {},
  });
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    await sharePictureFolders(config, ["ada", "bea", "cal"]);

    expect([modeOf(characterCacheDir(cache, "ada")), modeOf(characterCacheDir(cache, "bea")), modeOf(cache)]).toEqual([0o700, 0o700, 0o700]);
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([expect.stringContaining("could not open bea's pictures to shore-no-such-user, so the picture paths bea is given will not open: ") as unknown as string]);
  } finally {
    warned.mockRestore();
  }
});
