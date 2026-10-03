import { writePromptSnapshotFile } from "./support/storage.ts";
import { readdir } from "./support/stored_files.ts";
import { readFile } from "./support/stored_files.ts";
import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir,  writeFile } from "node:fs/promises";
import { join } from "node:path";

import rawFixture from "./handler_captures/context.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);

import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { characterDataDir } from "../src/config/dirs.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { ResolvedModel } from "../src/config/models.ts";
import type { AssembledPrompt, PromptMessage } from "../src/engine/prompt.ts";
import type { ContentBlock, ImageRef, Message, Role } from "../src/engine/types.ts";
import type { Sdk, ToolDefinition } from "../src/llm/types.ts";
import { prepareChatContext } from "../src/handler/context.ts";
import {
  assistantImageModeForRequest,
  buildLlmMessages,
  type AssistantImageMode,
} from "../src/handler/wire_messages.ts";
import { testTmp } from "./support/tmp.ts";
import { sizedImage } from "./support/sized_image.ts";

interface FixturePromptMessage {
  role: Role;
  content: string;
  images: { path: string; caption: string | null }[];
  content_blocks: ContentBlock[];
  provider_key: string | null;
  model: string | null;
}

interface BuildCase {
  name: string;
  note: string;
  mode: AssistantImageMode;
  prompt: {
    system: { label: string; content: string }[];
    messages: FixturePromptMessage[];
  };
  messages: unknown[];
  system: { text: string; label: string }[];
}

interface ContextCase {
  name: string;
  note: string;
  input: {
    character: string;
    display_name: string;
    active_files: { name: string; content: string }[];
    canonical_files: { name: string; content: string }[];
    enabled_tools: string[];
    enabled_subagents: string[];
    subagents: { name: string; description: string; prompt: string }[];
    mcp_tool_defs: ToolDefinition[];
    has_prior_context: boolean;
    timestamps: "never" | "always" | "auto";
    block_active_prompt: boolean;
    sdk: Sdk;
    max_context_tokens: number;
    max_output_tokens: number;
    messages: Message[];
  };
  llm_messages: unknown[];
  system: { text: string; label: string }[];
  tool_defs: string[] | null;
  prompt_messages: FixturePromptMessage[];
  active_after: { name: string; content: string }[] | null | "absent";
}

const ZONE = fixture.timezone;

function expectJson(got: unknown, want: unknown): void {
  expect(JSON.parse(JSON.stringify(got))).toEqual(want as never);
}

const buildCases = fixture.build_llm_messages as unknown as BuildCase[];
const modeCases = fixture.assistant_image_mode as unknown as {
  sdk: Sdk;
  has_tool_defs: boolean;
  mode: AssistantImageMode;
}[];
const contextCases = fixture.prepare_chat_context as unknown as ContextCase[];

const IMAGES_PLACEHOLDER = "{images}";

function recordedImages(): Map<string, string> {
  const out = new Map<string, string>();

  const walkBlocks = (blocks: unknown, names: string[]): void => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      const b = block as { type?: string; source?: { data?: string }; content?: unknown };
      if (b.type === "image" && typeof b.source?.data === "string") {
        const name = names.shift();
        if (name !== undefined) out.set(name, b.source.data);
      }
      if (b.type === "tool_result") walkBlocks(b.content, names);
    }
  };

  for (const c of buildCases) {
    const names = c.prompt.messages
      .flatMap((m) => m.images)
      .map((i) => i.path)
      .filter((p) => p.startsWith(IMAGES_PLACEHOLDER))
      .map((p) => p.slice(IMAGES_PLACEHOLDER.length + 1));
    for (const m of c.messages) walkBlocks((m as { content?: unknown }).content, names);
  }

  return out;
}

let imagesDir: string | undefined;

async function images(): Promise<string> {
  if (imagesDir !== undefined) return imagesDir;
  const dir = join(await mkdtemp(testTmp("shore-ctx-")), "images");
  await mkdir(dir, { recursive: true });
  for (const [name, data] of recordedImages()) {
    await writeFile(join(dir, name), Buffer.from(data, "base64"));
  }
  imagesDir = dir;
  return dir;
}

function expandPath(path: string, dir: string): string {
  return path.startsWith(IMAGES_PLACEHOLDER)
    ? join(dir, path.slice(IMAGES_PLACEHOLDER.length + 1))
    : path;
}

function promptMessage(m: FixturePromptMessage, dir: string): PromptMessage {
  const imageRefs: ImageRef[] = m.images.map((i) => ({
    path: expandPath(i.path, dir),
    ...(i.caption === null ? {} : { caption: i.caption }),
  }));
  return {
    role: m.role,
    content: m.content,
    images: imageRefs,
    content_blocks: m.content_blocks,
    ...(m.provider_key === null ? {} : { provider_key: m.provider_key }),
    ...(m.model === null ? {} : { model: m.model }),
  };
}

describe("buildLlmMessages", () => {
  for (const c of buildCases) {
    test(c.name, async () => {
      const dir = await images();
      const prompt: Pick<AssembledPrompt, "system" | "messages"> = {
        system: c.prompt.system,
        messages: c.prompt.messages.map((m) => promptMessage(m, dir)),
      };
      const got = await buildLlmMessages(prompt, c.mode);
      expectJson(got.messages, c.messages);
      expectJson(got.system, c.system);
    });
  }

  test("an uncaptioned image carries no caption key at all", async () => {
    const dir = await images();
    const files = (await readdir(dir)).filter((f) => !f.startsWith("."));
    const path = join(dir, files[0] as string);

    const got = await buildLlmMessages(
      {
        system: [],
        messages: [
          { role: "assistant", content: "here", images: [{ path }], content_blocks: [] },
        ],
      },
      "tool_pair",
    );

    const toolUse = got.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => (b as { type?: string }).type === "tool_use") as
      | { input: Record<string, unknown> }
      | undefined;

    expect(toolUse, "tool_pair mode renders an image as a generate_image pair").toBeDefined();
    expect(
      Object.keys(toolUse?.input ?? {}),
      "an absent caption is an absent key, not a key holding undefined",
    ).toEqual([]);
  });

  test("every case renders identically on a second call", async () => {
    const dir = await images();
    for (const c of buildCases) {
      const build = async () =>
        await buildLlmMessages(
          { system: c.prompt.system, messages: c.prompt.messages.map((m) => promptMessage(m, dir)) },
          c.mode,
        );
      expect(await build()).toEqual(await build());
    }
  });
});

describe("assistantImageModeForRequest", () => {
  for (const c of modeCases) {
    test(`${c.sdk} with${c.has_tool_defs ? "" : "out"} tool defs`, () => {
      expect(assistantImageModeForRequest(c.sdk, c.has_tool_defs)).toBe(c.mode);
    });
  }

  test("covers every sdk", () => {
    expect(new Set(modeCases.map((c) => c.sdk)).size).toBe(8);
  });
});

async function contextFixture(c: ContextCase): Promise<{
  config: LoadedConfig;
  charDataDir: string;
  activeDir: string;
  resolved: ResolvedModel;
}> {
  const root = await mkdtemp(testTmp("shore-ctx-case-"));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");

  const canonical = join(configDir, "characters", c.input.character, "workspace");
  await mkdir(canonical, { recursive: true });
  for (const f of c.input.canonical_files) await writeFile(join(canonical, f.name), f.content);

  const charDataDir = characterDataDir(dataDir, c.input.character);
  const activeDir = join(charDataDir, "active_prompt");
  if (c.input.block_active_prompt) {
    await writeFile(join(canonical, "TOOLS.md"), await Bun.file(join(import.meta.dir, "../prompts/engine/default_tools.md")).text());
    await writeFile(join(canonical, "memory"), "not a directory");
  } else {
    for (const f of c.input.active_files) writePromptSnapshotFile(join(activeDir, f.name), f.content);
  }
  await mkdir(cacheDir, { recursive: true });

  const app: AppConfig = defaultAppConfig();
  app.defaults.display_name = c.input.display_name;
  app.behavior.user_message_timestamps = c.input.timestamps;
  app.tools.enabled_tools = c.input.enabled_tools;
  app.tools.enabled_subagents = c.input.enabled_subagents;
  for (const s of c.input.subagents) {
    app.subagents.set(s.name, {
      description: s.description,
      prompt: s.prompt,
      tools: [],
      model: undefined,
      max_iterations: undefined,
      timeout: undefined,
    });
  }

  const dirs: ShoreDirs = {
    config: configDir,
    data: dataDir,
    cache: cacheDir,
    runtime: join(root, "run"),
  };

  return {
    config: {
      app,
      models: emptyCatalog(),
      providers: ProviderRegistry.empty(),
      dirs,
      rawTable: undefined,
    },
    charDataDir,
    activeDir,
    resolved: {
      name: "test",
      qualifiedName: "chat.test",
      category: "chat",
      providerKey: "anthropic",
      sdk: c.input.sdk,
      modelId: "test-model",
      maxContextTokens: c.input.max_context_tokens,
      maxOutputTokens: c.input.max_output_tokens,
    },
  };
}

describe("prepareChatContext", () => {
  test("prompt files reach system blocks with their own formatting intact", async () => {
    const base = contextCases[0];
    if (base === undefined) throw new Error("missing context fixture");
    const files = [
      { name: "AGENTS.md", label: "system", content: "\n# My instructions\n<rules>Be concise.</rules>\n" },
      { name: "TOOLS.md", label: "tools_guidance", content: "Use bash when needed.\n" },
      { name: "SOUL.md", label: "character", content: "<my_identity>My own framing.</my_identity>\n" },
      { name: "USER.md", label: "user", content: "  User-authored whitespace.\n\n" },
      { name: "MEMORY.md", label: "memory_index", content: "# Notes\nKeep exactly this context.\n" },
    ];
    const c = structuredClone(base);
    c.input.active_files = [];
    c.input.canonical_files = files;
    const { config, charDataDir, resolved } = await contextFixture(c);
    const got = await prepareChatContext({
      character: c.input.character,
      characterDataDir: charDataDir,
      config,
      resolved,
      messages: c.input.messages,
      hasPriorContext: false,
      mcpToolDefs: [],
      timeZone: ZONE,
    });
    expect(got.system).toEqual(files.map(({ label, content }) => ({ label, text: content })));
    expect(got.prompt.system).toEqual(files.map(({ label, content }) => ({ label, content })));
  });

  test("the model's resolution tier decides how many pictures fit", async () => {
    const base = contextCases[0];
    if (base === undefined) throw new Error("missing context fixture");
    const c = structuredClone(base);
    c.input.active_files = [];
    c.input.canonical_files = [];
    c.input.max_context_tokens = 25_000;
    c.input.max_output_tokens = 0;
    const data = (await sizedImage(1920, 1080)).toString("base64");
    const screenshots: Message[] = Array.from({ length: 10 }, (_, i) => ({
      msg_id: `u${String(i)}`,
      role: "user",
      content: "",
      images: [],
      content_blocks: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      timestamp: `2026-09-30T00:0${String(i)}:00Z`,
    }));
    const kept = async (modelId: string): Promise<number> => {
      const { config, charDataDir, resolved } = await contextFixture(c);
      const got = await prepareChatContext({
        character: c.input.character,
        characterDataDir: charDataDir,
        config,
        resolved: { ...resolved, modelId },
        messages: screenshots,
        hasPriorContext: false,
        mcpToolDefs: [],
        timeZone: ZONE,
      });
      return got.prompt.messages.length;
    };
    expect(await kept("claude-haiku-4-5")).toBe(10);
    expect(await kept("claude-opus-5-5")).toBeLessThan(10);
  });

  for (const c of contextCases) {
    test(c.name, async () => {
      const dir = await images();
      const { config, charDataDir, activeDir, resolved } = await contextFixture(c);

      const got = await prepareChatContext({
        character: c.input.character,
        characterDataDir: charDataDir,
        config,
        resolved,
        messages: c.input.messages.map((m) => ({
          ...m,
          images: m.images.map((i) => ({ ...i, path: expandPath(i.path, dir) })),
        })),
        hasPriorContext: c.input.has_prior_context,
        mcpToolDefs: c.input.mcp_tool_defs,
        timeZone: ZONE,
      });

      expectJson(got.system, c.system);
      expectJson(got.llmMessages, c.llm_messages);
      expect(
        got.toolDefs?.map((t) => t.name) ?? null,
        `${c.name}: the tools this context offers`,
      ).toEqual(c.tool_defs);
      for (const tool of got.toolDefs ?? []) {
        expect(
          typeof tool.description === "string" && tool.description !== "",
          `${tool.name} tells the model what it is for`,
        ).toBe(true);
        expect((tool.input_schema as { type?: string }).type, `${tool.name} takes an object`).toBe(
          "object",
        );
      }

      expectJson(got.prompt.messages, c.prompt_messages.map((m) => promptMessage(m, dir)));

      if (c.active_after === null) {
        expect(await readdir(activeDir).catch(() => [])).toEqual([]);
      } else if (c.active_after === "absent") {
        expect(await lstat(activeDir).catch(() => undefined)).toBeUndefined();
      } else {
        const after = await Promise.all(
          (await readdir(activeDir)).sort().map(async (name) => ({
            name,
            content: await readFile(join(activeDir, name), "utf8"),
          })),
        );
        expect(after).toEqual(c.active_after);
      }
    });
  }

});
