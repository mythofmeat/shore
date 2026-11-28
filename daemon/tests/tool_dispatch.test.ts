import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultImagesConfig } from "../src/config/app.ts";
import { dispatchTool, type ToolContext } from "../src/tools/dispatch.ts";
import { toolMediaOf } from "../src/tools/media.ts";
import { transparentPng } from "./support/test_images.ts";
import { Texts } from "../src/texts/texts.ts";
import { schemaViolation } from "../src/tools/validate.ts";
import { SUBAGENT_INPUT_SCHEMA } from "../src/tools/registry.ts";

async function refused(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

async function workspace(): Promise<ToolContext> {
  const dir = mkdtempSync(join(tmpdir(), "shore-tool-dispatch-"));
  writeFileSync(join(dir, "long.md"), Array.from({ length: 200 }, (_, line) => `line ${String(line)} of the keeper's log`).join("\n"));
  writeFileSync(join(dir, "note.md"), "The lamp:\n\n![[lamp.png]]\n");
  await Bun.write(join(dir, "lamp.png"), transparentPng(64, 64));
  return { texts: new Texts(), workspaceDir: dir, characterName: "ada", characterDataDir: dir, conversationDir: dir, historyDbPath: join(dir, "shore.db"), configDir: dir };
}

test("a read is held to the result size, the inline picture budget and the picture settings the turn gives it", async () => {
  const ctx = await workspace();
  const firstLine = async (extra: Partial<ToolContext>) => String(await dispatchTool("read", { file_path: "long.md" }, { ...ctx, ...extra })).split("\n")[0]?.split("long.md: ")[1];
  expect(await firstLine({})).toBe("lines 1–200");
  expect(await firstLine({ maxResultChars: 700 })).toBe("lines 1–6");

  const note = async (extra: Partial<ToolContext>) => {
    const carried = toolMediaOf(await dispatchTool("read", { file_path: "note.md" }, { ...ctx, ...extra }));
    return [carried?.media.map((item) => item.mime_type), carried?.notes];
  };
  expect(await note({})).toEqual([["image/png"], []]);
  expect(await note({ maxInlineImageBytes: 10 })).toEqual([
    [], ["[Markdown image(s) ![[lamp.png]] not read: they would not fit the 10-byte inline image budget for this read. Read those image files directly to view them.]"],
  ]);

  const original = async (extra: Partial<ToolContext>) => await refused(dispatchTool("read", { file_path: "lamp.png", original: true }, { ...ctx, ...extra }));
  expect(await original({})).toBe("");
  const images = defaultImagesConfig();
  expect(await original({ images: { ...images, read: { ...images.read, allow_original: false } } })).toBe(
    "invalid args: original is turned off by images.read.allow_original; images are sent at the configured size",
  );
});

test("a tool whose service the turn doesn't have says so, and a name that is no tool is said to be none", async () => {
  const ctx = await workspace();
  expect(await refused(dispatchTool("model_history", {}, ctx))).toBe("io: the usage ledger is not available in this context");
  expect(await refused(dispatchTool("activity_heatmap", {}, ctx))).toBe("io: activity history is not available in this context");
  expect(await refused(dispatchTool("mcp__weather__look", { place: "quay" }, ctx))).toBe("mcp__weather__look: not yet implemented");
  expect(await refused(dispatchTool("ask_scout", { query: "where is the log?" }, ctx))).toBe("ask_scout: not yet implemented");
  expect(await refused(dispatchTool("frobnicate", {}, ctx))).toBe("frobnicate: not yet implemented");
  expect(await refused(dispatchTool("generate_image", { prompt: "a lamp" }, ctx))).toBe("generate_image: not yet implemented");
});

test("a sub-agent is asked by its name with the query, and an outside tool is called with what it was given", async () => {
  const ctx = await workspace();
  const asked: unknown[] = [];
  const signal = new AbortController().signal;
  const wired: ToolContext = {
    ...ctx,
    signal,
    toolUseId: "tu_1",
    runSubagent: async (...given) => { asked.push(["subagent", ...given]); return "the scout's answer"; },
    mcpCall: async (...given) => { asked.push(["mcp", ...given]); return "sunny"; },
  };
  expect(await dispatchTool("ask_scout", { query: "where is the log?" }, wired)).toBe("the scout's answer");
  expect(await dispatchTool("mcp__weather__look", { place: "quay" }, wired)).toBe("sunny");
  expect(asked).toEqual([
    ["subagent", "scout", "where is the log?", signal, "tu_1"],
    ["mcp", "mcp__weather__look", { place: "quay" }, signal],
  ]);
  expect(schemaViolation(new Texts(), SUBAGENT_INPUT_SCHEMA, { query: 5 })).toBe("argument `query` must be a string");
  expect(schemaViolation(new Texts(), SUBAGENT_INPUT_SCHEMA, {})).toBe("the required argument `query` was missing");
  expect(asked).toHaveLength(2);
});
