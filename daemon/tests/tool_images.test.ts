import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { embedImageData } from "../src/engine/wire_images.ts";
import type { ImageRef, Message } from "../src/engine/types.ts";
import { cachedImageBytes } from "../src/storage/image_cache.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, toolPhase, type ToolExecution } from "../src/tools/execute.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";
import { noisePng } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";

async function world() {
  const root = testTmp(`tool-images-${crypto.randomUUID()}`);
  const data = join(root, "data");
  const cache = join(root, "cache");
  const workspaceDir = join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(data, { recursive: true });
  const ctx: ToolContext = {
    workspaceDir, characterName: "ada", characterDataDir: join(data, "ada"), imageDir: join(root, "media"), cacheDir: cache,
    conversationDir: join(data, "ada", "threads", "main"), historyDbPath: join(data, "shore.db"), configDir: root, shownPictures: [],
  };
  const exec: ToolExecution = {
    ctx, sendDirect: () => {}, schemas: BUILTIN_TOOL_SCHEMAS,
    limits: { max_result_chars: 50_000, timeout_ms: 5000 },
    now: () => "2026-10-22T10:00:00+11:00", newMessageId: () => crypto.randomUUID(),
  };
  const messages: Message[] = [];
  const phase = toolPhase(exec, messages);
  const read = async (file_path: string): Promise<ImageRef[]> => {
    const block = await phase.runTool({ id: crypto.randomUUID(), name: "read", input: { file_path } });
    await phase.recordTurn("user", [block]);
    return messages.at(-1)?.images ?? [];
  };
  const run = async (name: string, input: unknown) => {
    const result = await runToolUse({ id: crypto.randomUUID(), name, input }, exec, []);
    return { isError: result.isError, text: result.output };
  };
  return { root, cache, workspaceDir, read, run };
}

function embedded(image: ImageRef): string | undefined {
  const copy = [{ ...image }];
  embedImageData(copy);
  return copy[0]?.data;
}

test("reading a workspace picture again and again keeps no copy of it in the image cache", async () => {
  const { cache, workspaceDir, read } = await world();
  const png = Buffer.from(await noisePng(64, 64, 5));
  const file = join(workspaceDir, "drawing.png");
  await writeFile(file, png);
  await writeFile(join(workspaceDir, "page.md"), "![](drawing.png)\n");

  const shown = [...await read("drawing.png"), ...await read("drawing.png"), ...await read("page.md")];

  expect(shown.map((image) => image.path)).toEqual([file, file, file]);
  expect(cachedImageBytes(cache)).toBe(0);
  expect(embedded(shown[0] as ImageRef)).toBe(png.toString("base64"));
});

test("a workspace picture that changed after it was shown is no longer shown or saved as that picture", async () => {
  const { workspaceDir, read, run } = await world();
  const file = join(workspaceDir, "drawing.png");
  await writeFile(file, Buffer.from(await noisePng(8, 8, 1)));
  const [shown] = await read("drawing.png");
  if (shown?.sha256 === undefined) throw new Error("the picture was not shown with a hash");

  await writeFile(file, Buffer.from(await noisePng(8, 8, 2)));

  expect(embedded(shown)).toBeUndefined();
  const saved = await run("save_picture", { picture: shown.sha256.slice(0, 8), path: "kept.png" });
  expect(saved.isError).toBe(true);
  expect(saved.text).toContain("changed");
});

test("a picture outside the workspace that is overwritten keeps every version it was read as", async () => {
  const { root, workspaceDir, read, run } = await world();
  const sheet = join(root, "tmp", "contact-sheet.png");
  await mkdir(join(root, "tmp"), { recursive: true });
  const first = Buffer.from(await noisePng(8, 8, 3));
  const second = Buffer.from(await noisePng(8, 8, 4));
  await writeFile(sheet, first);
  const [before] = await read(sheet);
  await writeFile(sheet, second);
  const [after] = await read(sheet);
  if (before?.sha256 === undefined || after?.sha256 === undefined) throw new Error("the pictures were not shown with a hash");

  expect([embedded(before), embedded(after)]).toEqual([first.toString("base64"), second.toString("base64")]);
  for (const [image, name] of [[before, "first.png"], [after, "second.png"]] as const) {
    const saved = await run("save_picture", { picture: image.sha256?.slice(0, 8), path: name });
    expect(saved.isError).toBe(false);
  }
  expect([await readFile(join(workspaceDir, "first.png")), await readFile(join(workspaceDir, "second.png"))]).toEqual([first, second]);
});
