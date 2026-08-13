/**
 * Recorded cases for context.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fixture from "./handler_fixtures/context.json" with { type: "json" };

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

// ── Fixture shapes ──────────────────────────────────────────────────────

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
    /** `active_prompt` is a regular file, so the snapshot step fails. */
    block_active_prompt: boolean;
    sdk: Sdk;
    max_context_tokens: number;
    max_output_tokens: number;
    messages: Message[];
  };
  llm_messages: unknown[];
  system: { text: string; label: string }[];
  tool_defs: ToolDefinition[] | null;
  prompt_messages: FixturePromptMessage[];
  /** `null` when `active_prompt` is not a directory to list. */
  active_after: { name: string; content: string }[] | null;
}

const ZONE = fixture.timezone as string;

/** Compare the bytes, not the object graph — see the module header. */
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

// ── Image materialization ───────────────────────────────────────────────

const IMAGES_PLACEHOLDER = "{images}";

/**
 * Every `(file name, bytes)` pair the fixture recorded, from the `base64` image
 * blocks in its expected output.
 *
 * A file appears once no matter how many cases use it, and the bytes are
 * identical across cases by construction — the generator wrote each image once.
 * A file that only ever appears in a *failing* encode (a `/nonexistent/` path)
 * never shows up here, which is exactly right: those cases need it absent.
 */
function recordedImages(): Map<string, string> {
  const out = new Map<string, string>();

  const walkBlocks = (blocks: unknown, names: string[]): void => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      const b = block as { type?: string; source?: { data?: string }; content?: unknown };
      if (b.type === "image" && typeof b.source?.data === "string") {
        // Blocks are emitted in image order within a turn, so the nth image
        // block of a case corresponds to the nth `{images}` path it declared.
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

/** The shared image directory, built once from the fixture's own bytes. */
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
  const images: ImageRef[] = m.images.map((i) => ({
    path: expandPath(i.path, dir),
    ...(i.caption === null ? {} : { caption: i.caption }),
  }));
  return {
    role: m.role,
    content: m.content,
    images,
    content_blocks: m.content_blocks,
    ...(m.provider_key === null ? {} : { provider_key: m.provider_key }),
    ...(m.model === null ? {} : { model: m.model }),
  };
}

// ── build_llm_messages ──────────────────────────────────────────────────

describe("buildLlmMessages", () => {
  for (const c of buildCases) {
    test(c.name, async () => {
      const dir = await images();
      const prompt: AssembledPrompt = {
        system: c.prompt.system,
        messages: c.prompt.messages.map((m) => promptMessage(m, dir)),
      };
      const got = await buildLlmMessages(prompt, c.mode);
      expectJson(got.messages, c.messages);
      expectJson(got.system, c.system);
    });
  }

  // Prompt-cache stability: identical history must render to identical JSON, so
  // the synthetic tool_use ids derive from the image path and never from
  // randomness or an unstable hash. Every case is replayed twice rather than
  // one hand-picked one, since a single nondeterministic block anywhere is
  // enough to lose the prefix.
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
    // A new SDK that nobody adds a row for would otherwise inherit
    // `text_standin` silently, which is the safe answer but not a tested one.
    expect(new Set(modeCases.map((c) => c.sdk)).size).toBe(7);
  });
});

// ── prepare_chat_context ────────────────────────────────────────────────

/** Rebuild one case's on-disk layout and the config that points at it. */
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
    await mkdir(charDataDir, { recursive: true });
    await writeFile(activeDir, "not a directory");
  } else {
    await mkdir(activeDir, { recursive: true });
    for (const f of c.input.active_files) await writeFile(join(activeDir, f.name), f.content);
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
      expectJson(got.toolDefs ?? null, c.tool_defs);

      expectJson(got.prompt.messages, c.prompt_messages.map((m) => promptMessage(m, dir)));

      // The snapshot the call was supposed to have materialized. Checking only
      // the return value would let a `prepare` that never seeded `active_prompt`
      // pass every case whose files were already there.
      if (c.active_after === null) {
        // The blocked case: `active_prompt` was a file going in and the failure
        // was warned about rather than thrown, so it is still a file.
        expect((await lstat(activeDir)).isFile()).toBe(true);
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
