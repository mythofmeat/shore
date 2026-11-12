import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { characterCacheDir } from "../src/config/dirs.ts";
import { loadConfig } from "../src/config/loader.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { ingestImages } from "../src/handler/images.ts";
import { buildLlmMessages } from "../src/handler/wire_messages.ts";
import { toolResultText } from "../src/llm/types.ts";
import { shoreLog } from "../src/log.ts";
import { findModelCopy } from "../src/llm/images.ts";
import { evictCachedImages } from "../src/storage/image_cache.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
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
  expect(captured.text).toBe(`captured\n[screenshot attached; its file is ${file}]`);
  expect(dirname(file)).toBe(join(characterCacheDir(cache, "ada"), "images", "tools"));
  expect(await readFile(file)).toEqual(png);

  const drawing = join(workspaceDir, "drawing.png");
  const read = await run("read", { file_path: "drawing.png" });
  expect(read.text).toBe(`${drawing}: image/png, 4×4, ${String(png.byteLength)} bytes\n[${drawing} attached]`);
});

test("a picture read from a file that had to be made smaller says so, and still names the file it came from", async () => {
  const { workspaceDir, run } = await world();
  const file = join(workspaceDir, "wide.png");
  const png = Buffer.from(await noisePng(2400, 8, 5));
  await writeFile(file, png);

  const lines = (await run("read", { file_path: "wide.png" })).text.split("\n");

  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(`${file}: image/png, 2400×8, ${String(png.byteLength)} bytes`);
  expect(lines[1]).toStartWith(`[${file}: reduced from `);
  expect(lines[1]).toContain(" 2400×8");
  expect(lines[2]).toBe(`[${file} attached]`);
});

test("a picture whose file is gone but whose copy for the model is not is still shown, without a path that would not open", async () => {
  const { send } = await world();
  const message = await send(Buffer.from(await noisePng(4, 4, 13)));
  const file = message.images[0]?.path ?? "";
  expect(findModelCopy(file)).toBeDefined();

  await rm(file);

  expect(await shownAs(message)).toEqual(["image", "look"]);
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

test("a character's cache folder is closed before its group changes, so the new group never finds it open", () => {
  const cache = join(testTmp(`picture-regroup-${crypto.randomUUID()}`), "cache");
  const folder = characterCacheDir(cache, "ada");
  mkdirSync(join(folder, "images"), { recursive: true });
  chmodSync(folder, 0o770);
  const gid = process.getgid?.() ?? 0;
  const chownSync = fs.chownSync;
  const modesWhenRegrouped: number[] = [];
  const regroup = spyOn(fs, "chownSync").mockImplementation((path, uid, group) => {
    modesWhenRegrouped.push(modeOf(String(path)));
    chownSync(path, uid, group);
  });
  try {
    openPictureFolder(cache, "ada", gid);
  } finally {
    regroup.mockRestore();
  }

  expect(modesWhenRegrouped).toEqual([0o700]);
  expect([modeOf(folder), statSync(folder).gid]).toEqual([0o710, gid]);
});

test("starting up opens each character's pictures to its tools user, and says so when that user cannot reach them", async () => {
  const root = testTmp(`picture-reach-${crypto.randomUUID()}`);
  const cache = join(root, "cache");
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  for (const name of ["ada", "bea"]) {
    await mkdir(join(root, "characters", name), { recursive: true });
    await writeFile(join(root, "characters", name, "config.toml"), `[tools]\nuser = "${String(uid)}:${String(gid)}"\n`);
  }
  await writeFile(join(root, "config.toml"), "");
  mkdirSync(cache, { recursive: true });
  chmodSync(cache, 0o700);
  const config = loadConfig(join(root, "config.toml"), {
    env: { SHORE_CONFIG_DIR: root, SHORE_DATA_DIR: join(root, "data"), SHORE_CACHE_DIR: cache },
    onWarn: () => {},
  });
  const pictures = (name: string) => join(characterCacheDir(cache, name), "images");
  const asked: string[] = [];
  const reach = spyOn(CharacterWorkspace.prototype, "call").mockImplementation(((op: string, args: { paths: string[] }) => {
    asked.push(`${op} ${args.paths.join(" ")}`);
    return Promise.resolve(args.paths.map((path) => path === pictures("ada")));
  }) as unknown as typeof CharacterWorkspace.prototype.call);
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    await sharePictureFolders(config, ["ada", "bea"]);

    expect(asked).toEqual([`exists ${pictures("ada")}`, `exists ${pictures("bea")}`]);
    for (const name of ["ada", "bea"]) {
      expect([modeOf(characterCacheDir(cache, name)), statSync(characterCacheDir(cache, name)).gid]).toEqual([0o710, gid]);
    }
    expect(modeOf(cache)).toBe(0o710);
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
      `shore: bea's tools run as ${String(uid)}:${String(gid)}, and that user cannot reach ${pictures("bea")}, so the picture paths bea is given will not open. ` +
        `It has to be in the daemon's group (gid ${String(gid)}) and able to pass every folder above ${cache}.`,
    ]);
  } finally {
    warned.mockRestore();
    reach.mockRestore();
  }
});

test("starting up closes every character's cache folder, and says so when a tools user cannot be given its pictures", async () => {
  const root = testTmp(`picture-sharing-${crypto.randomUUID()}`);
  const cache = join(root, "cache");
  await mkdir(join(root, "characters", "bea"), { recursive: true });
  await writeFile(join(root, "config.toml"), "");
  await writeFile(join(root, "characters", "bea", "config.toml"), '[tools]\nuser = "shore-no-such-user"\n');
  const uid = process.getuid?.() ?? 0;
  await mkdir(join(root, "characters", "dot"), { recursive: true });
  await writeFile(join(root, "characters", "dot", "config.toml"), `[tools]\nuser = "${String(uid)}:4000000000"\n`);
  for (const name of ["ada", "bea", "dot"]) mkdirSync(join(characterCacheDir(cache, name), "images"), { recursive: true });
  chmodSync(cache, 0o700);
  const config = loadConfig(join(root, "config.toml"), {
    env: { SHORE_CONFIG_DIR: root, SHORE_DATA_DIR: join(root, "data"), SHORE_CACHE_DIR: cache },
    onWarn: () => {},
  });
  const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
  try {
    await sharePictureFolders(config, ["ada", "bea", "cal", "dot"]);

    expect(["ada", "bea", "dot"].map((name) => modeOf(characterCacheDir(cache, name)))).toEqual([0o700, 0o700, 0o700]);
    expect(modeOf(cache)).toBe(0o700);
    const dotFolder = characterCacheDir(cache, "dot");
    expect(warned.mock.calls.map(([line]) => String(line))).toEqual([
      "shore: could not open bea's pictures to shore-no-such-user, so the picture paths bea is given will not open: " +
        "CharacterUserError: tools.user names shore-no-such-user, but this system has no user by that name.",
      `shore: could not open dot's pictures to ${String(uid)}:4000000000, so the picture paths dot is given will not open: ` +
        `Error: EPERM: operation not permitted, chown '${dotFolder}'. The daemon's user has to be in that user's group.`,
    ]);
  } finally {
    warned.mockRestore();
  }
});
