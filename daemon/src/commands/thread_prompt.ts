import type { ThreadPromptView } from "../protocol/ThreadPromptView.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { characterDataDir } from "../config/dirs.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { configView, resolveActiveModelAndOverlay } from "../config/preferences.ts";
import { threadActivityNow, threadModelOf, type ThreadRecord } from "../engine/threads.ts";
import { previewThreadPrompt } from "../handler/context.ts";
import { resolveGenerationModel } from "../handler/setup.ts";
import { cacheTtlSecs } from "../llm/request.ts";
import { applyDeferredEdits } from "../memory/deferred_edits.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { invalidRequest, notFound } from "./errors.ts";
import type { Args } from "./navigation.ts";

export interface ThreadPromptContext {
  config: LoadedConfig;
  dataDir: string;
  character: string;
  home: string;
  threads: readonly ThreadRecord[];
  now: () => number;
}

function namedThread(ctx: ThreadPromptContext, args: Args): string {
  const id = args["name"];
  if (typeof id !== "string") throw invalidRequest("Missing required argument: name");
  if (!ctx.threads.some((thread) => thread.id === id)) throw notFound(`Thread not found: ${id}`);
  return id;
}

async function view(ctx: ThreadPromptContext, thread: string): Promise<ThreadPromptView> {
  const { model, overlay } = resolveActiveModelAndOverlay(
    configView(ctx.config),
    ctx.character,
    findEffectiveModel,
    threadModelOf(ctx.threads, thread),
  );
  const resolved = resolveGenerationModel(model, ctx.config, overlay);
  const lastActive = Date.parse(threadActivityNow(ctx.dataDir, ctx.character, thread).last_active ?? "");
  const preview = await previewThreadPrompt({
    character: ctx.character,
    characterDataDir: characterDataDir(ctx.dataDir, ctx.character),
    config: ctx.config,
    resolved,
    thread,
    refreshing: thread !== ctx.home && ctx.now() - lastActive >= cacheTtlSecs(resolved) * 1000,
  });
  return {
    thread,
    parts: preview.system.map((block) => ({ label: block.label, text: block.content, changed: preview.changed.has(block.label) })),
    pins: preview.pins.map(({ pin, bytes, shown, changed }) => ({ pin, bytes, shown, changed })),
  };
}

export async function threadPrompt(ctx: ThreadPromptContext, args: Args): Promise<ThreadPromptView> {
  return await view(ctx, namedThread(ctx, args));
}

export async function refreshThreadPrompt(ctx: ThreadPromptContext, args: Args): Promise<ThreadPromptView> {
  const thread = namedThread(ctx, args);
  await applyDeferredEdits(characterDataDir(ctx.dataDir, ctx.character), characterWorkspace(ctx.config, ctx.character), thread);
  return await view(ctx, thread);
}
