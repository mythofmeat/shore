import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HistoryStore } from "../src/engine/history_store.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { ingestImages } from "../src/handler/images.ts";
import { buildLlmMessages } from "../src/handler/wire_messages.ts";
import { toolResultText } from "../src/llm/types.ts";
import { threadFile } from "../src/storage/files.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, toolPhase, type ToolExecution } from "../src/tools/execute.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";
import { noisePng } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";

async function world() {
  const root = testTmp(`save-picture-${crypto.randomUUID()}`);
  const data = join(root, "data");
  const cache = join(root, "cache");
  const workspaceDir = join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(data, { recursive: true });
  const ctx: ToolContext = {
    workspaceDir, characterName: "ada", characterDataDir: join(data, "ada"), imageDir: join(root, "media"), cacheDir: cache,
    conversationDir: join(data, "ada", "threads", "main"), historyDbPath: join(data, "shore.db"), configDir: root, shownPictures: [],
  };
  const active = await MessageStore.load(threadFile(data, "ada", "main", "active.jsonl"));
  const exec: ToolExecution = {
    ctx, sendDirect: () => {}, schemas: BUILTIN_TOOL_SCHEMAS,
    limits: { max_result_chars: 50_000, timeout_ms: 5000 },
    now: () => "2026-10-21T10:00:00+11:00", newMessageId: () => crypto.randomUUID(),
    onRecordTurn: (message) => active.append(message),
  };
  const run = async (name: string, input: unknown) => {
    const result = await runToolUse({ id: crypto.randomUUID(), name, input }, exec, []);
    return { isError: result.isError, text: result.output };
  };
  const send = async (png: Buffer): Promise<Message> => {
    const { images } = await ingestImages(cache, "ada", ["cat.png"], [{ filename: "cat.png", data: png.toString("base64") }]);
    const message: Message = {
      msg_id: crypto.randomUUID(), role: "user", content: "look", images,
      content_blocks: [{ type: "text", text: "look" }], timestamp: "2026-10-21T09:00:00+11:00",
    };
    await active.append(message);
    return message;
  };
  return { root, cache, workspaceDir, ctx, exec, active, run, send };
}

async function picture(seed: number): Promise<Buffer<ArrayBuffer>> {
  return Buffer.from(await noisePng(4, 4, seed));
}

function idIn(text: string, pattern: RegExp): string {
  const id = pattern.exec(text)?.[1];
  if (id === undefined) throw new Error(`no picture id in ${text}`);
  return id;
}

test("a picture the user sent is shown with an id that saves it into the workspace until it is evicted", async () => {
  const { workspaceDir, run, send } = await world();
  const png = await picture(7);
  const message = await send(png);

  const { messages } = await buildLlmMessages({ system: [], messages: [message] }, "text_standin");
  const content = messages[0]?.content ?? [];
  const at = content.findIndex((block) => block.type === "text" && block.text.startsWith("[picture "));
  const label = content[at];
  if (label?.type !== "text") throw new Error("the picture was shown without an id");
  expect(content[at + 1]?.type).toBe("image");
  const id = idIn(label.text, /^\[picture ([0-9a-f]{8})\]$/);

  const saved = await run("save_picture", { picture: id.slice(0, 6), path: "keep/cat" });
  expect(saved).toMatchObject({ isError: false });
  expect(await readFile(join(workspaceDir, "keep", "cat.png"))).toEqual(png);

  const cached = message.images[0]?.path ?? "";
  await writeFile(cached, await picture(8));
  expect(await run("save_picture", { picture: id, path: "keep/other.png" })).toMatchObject({ isError: true });
  expect(existsSync(join(workspaceDir, "keep", "other.png"))).toBe(false);

  await rm(cached);
  const evicted = await run("save_picture", { picture: id, path: "keep/again.png" });
  expect(evicted.isError).toBe(true);
  expect(evicted.text).toContain("evicted");
  expect(existsSync(join(workspaceDir, "keep", "again.png"))).toBe(false);
});

test("a picture from a tool result can be saved by its id in later turns, and once it is in the chat logs", async () => {
  const { ctx, exec, active, workspaceDir, run } = await world();
  const png = await picture(11);
  await writeFile(join(workspaceDir, "drawing.png"), png);

  const phase = toolPhase(exec);
  const block = await phase.runTool({ id: "toolu_read", name: "read", input: { file_path: "drawing.png" } });
  await phase.recordTurn("user", [block]);
  const result = block as Extract<ContentBlock, { type: "tool_result" }>;
  const id = idIn(toolResultText(result.content), /drawing\.png attached as picture ([0-9a-f]{8})\]/);

  ctx.shownPictures = [];
  expect(await run("save_picture", { picture: id, path: "later.png" })).toMatchObject({ isError: false });
  expect(await readFile(join(workspaceDir, "later.png"))).toEqual(png);

  const archived = [...active.messages()];
  const history = HistoryStore.open(ctx.historyDbPath);
  history.putSegment("ada", 0, { file: "0.jsonl", message_count: archived.length, compacted_at: "2026-10-21T11:00:00+11:00" }, archived);
  history.close();
  await active.deleteAll(archived.map((message) => message.msg_id));

  expect(await run("save_picture", { picture: id, path: "archived.png" })).toMatchObject({ isError: false });
  expect(await readFile(join(workspaceDir, "archived.png"))).toEqual(png);
});

test("save_picture writes only new files inside the workspace", async () => {
  const { root, workspaceDir, run, send } = await world();
  const png = await picture(3);
  const message = await send(png);
  const id = message.images[0]?.sha256?.slice(0, 8) ?? "";
  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), join(workspaceDir, "link"));
  await writeFile(join(workspaceDir, "taken.png"), "mine");

  for (const path of ["../outside.png", join(root, "outside.png"), "link/escape.png", "taken.png", "cat.jpg"]) {
    expect(await run("save_picture", { picture: id, path })).toMatchObject({ isError: true });
  }
  expect(existsSync(join(root, "outside.png"))).toBe(false);
  expect(existsSync(join(root, "elsewhere", "escape.png"))).toBe(false);
  expect(existsSync(join(workspaceDir, "cat.jpg"))).toBe(false);
  expect(await readFile(join(workspaceDir, "taken.png"), "utf8")).toBe("mine");
});

test("an id that fits more than one picture lists them instead of picking one", async () => {
  const { cache, active, run } = await world();
  for (const digit of ["1", "2"]) {
    await active.append({
      msg_id: crypto.randomUUID(), role: "user", content: "", content_blocks: [], timestamp: "2026-10-21T09:00:00+11:00",
      images: [{ path: join(cache, `${digit}.png`), sha256: `abcdef0${digit}${"0".repeat(56)}` }],
    });
  }
  const ambiguous = await run("save_picture", { picture: "abcdef", path: "which.png" });
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.text).toContain("abcdef01");
  expect(ambiguous.text).toContain("abcdef02");
});
