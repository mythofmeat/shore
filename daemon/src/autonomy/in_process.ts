import { shoreLog } from "../log.ts";

import type { LoopToolResult, TranscriptRound } from "./background_loop.ts";
import { runIdleCompaction } from "./idle_compaction.ts";
import { runDeepIdleArchive } from "./deep_archive.ts";
import type { LastRequestCache } from "../cache/last_request.ts";
import type { PostArchiveEngine } from "./post_archive.ts";
import type { AutonomyActionResult, AutonomyExecutor, OpenedSeal, WakeHooks, WakeResult, WakeRun } from "./runner.ts";
import { runWake } from "./wake.ts";
import { sealedFilesDir } from "../handler/sealed_thread.ts";
import type { ToolContext } from "../tools/dispatch.ts";
import type { CompactionReason } from "./tick.ts";
import type { CharacterRegistry } from "../characters.ts";
import { resolveDisplayName } from "../config/app.ts";
import { rustJoin } from "../config/dirs.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { usageConfigView } from "../ledger/budget.ts";
import type { Message } from "../engine/types.ts";
import { generate, generateViaStream } from "../llm/generate.ts";
import type { GenerateDeps } from "../llm/generate.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest, ToolDefinition } from "../llm/types.ts";
import type { ToolContextDeps } from "../handler/tool_context.ts";
import { buildToolContext } from "../handler/tool_context.ts";
import { toolLimitsFrom } from "../tools/dispatch.ts";
import { imageLimitsFor, type ImageLimits } from "../llm/prepare_images.ts";
import type { CallStore } from "../call_store.ts";
import { recordTranscript } from "../transcript_capture.ts";
import { runToolUse, type ToolExecution, type ToolPhase } from "../tools/execute.ts";
import { schemasFrom } from "../tools/validate.ts";
import type { RebuildDeps } from "../cache/rebuild.ts";
import type { CompactionRunner } from "../handler/turn.ts";
import { compactionRunner } from "../memory/compaction/run.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { TranscriptSource } from "../protocol/TranscriptSource.ts";

export interface InProcessExecutorDeps {
  registry: CharacterRegistry;
  cache: LastRequestCache;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  emit?: (character: string, revision: number, msg: Message, thread: string) => void;
  emitEvent?: ((message: ServerMessage) => void) | undefined;
  notifyAutonomousMessage?: (title: string, body: string) => void;
  notifyCompactionComplete?: (title: string, body: string) => void;
  callStore?: Pick<CallStore, "recordTranscript">;
  tools?: ToolContextDeps;
  rebuild: RebuildDeps;
  env?: NodeJS.ProcessEnv;
  beginForeground?: () => () => void;
  runActivity?: <T>(run: () => Promise<T>) => Promise<T>;
}

export class InProcessAutonomyExecutor implements AutonomyExecutor {
  readonly #deps: InProcessExecutorDeps;

  constructor(deps: InProcessExecutorDeps) {
    this.#deps = deps;
  }

  homeThread(character: string): string {
    return this.#deps.registry.homeThread(character);
  }

  onHold(character: string, thread: string | undefined): boolean {
    return this.#deps.registry.listThreads(character).some((record) => record.id === thread && record.on_hold === true);
  }

  async runWake(character: string, wake: WakeRun, hooks: WakeHooks): Promise<WakeResult> {
    return await this.#withForeground(async () => {
      const config = this.#deps.registry.effectiveConfig(character);
      const calls = this.#loopCalls(config, character, "wake", ["wake", "wake_tool_loop"]);
      const { wakeInThread, ...rest } = this.#deps.tools ?? {};
      const handsOn = wakeInThread === undefined || wake.fired.some((firing) => firing.from !== undefined) ? {} : { wakeInThread };
      let toolCtx: ReturnType<typeof buildToolContext> | undefined;
      return await runWake(character, config, { thread: wake.thread, fired: wake.fired, limitMs: wake.limitMs }, {
        rebuild: this.#deps.rebuild,
        interrupted: wake.interrupted,
        compaction: this.#threadCompaction(),
        ...(this.#deps.env === undefined ? {} : { env: this.#deps.env }),
        news: (wrappingUp) => hooks.news(wrappingUp),
        newsHeard: () => { hooks.newsHeard(); },
        ...(rest.push === undefined ? {} : { push: async (message) => await rest.push?.(character, message) ?? { kind: "not_set_up" } }),
        generate: calls.generate,
        dispatch: async (name, input, toolUseId, tools, conversation) => {
          toolCtx ??= buildToolContext(config, config.dirs.data, character, { ...rest, ...handsOn, thread: conversation.thread, conversation: conversation.conversation, fresh: true });
          const ctx = {
            ...await toolCtx,
            ...(conversation.recordWorkspaceWrite === undefined ? {} : { recordWorkspaceWrite: conversation.recordWorkspaceWrite }),
            ...(conversation.sendMessage === undefined ? {} : { sendMessage: conversation.sendMessage }),
          };
          return await runLoopTool(ctx, config, calls.imageLimits(), { id: toolUseId ?? `wk_${crypto.randomUUID()}`, name, input }, tools);
        },
        ...this.#transcripts("wake", character),
        engine: async (name, thread) => this.#deps.registry.listThreads(name).some((record) => record.id === thread)
          ? await this.#deps.registry.getOrCreate(name, thread)
          : await this.#deps.registry.sealedEngine(name, thread),
        sealed: async (name, thread) => {
          const sealed = this.#deps.registry.sealedThreads(name).find((each) => each.id === thread);
          return sealed === undefined ? undefined : { sealed, filesDir: await sealedFilesDir(config, name, thread) };
        },
        workingLog: async (name) => {
          const { thread, created } = await this.#deps.registry.ensureWakesThread(name);
          if (created) this.#deps.emitEvent?.({ type: "threads_changed", character: name, thread });
          const label = this.#deps.registry.listThreads(name).find((record) => record.id === thread)?.label ?? thread;
          return { engine: await this.#deps.registry.getOrCreate(name, thread), label };
        },
        threadModel: (name, thread) => this.#deps.registry.listThreads(name).find((record) => record.id === thread)?.chat_model,
        ...(this.#deps.emit === undefined ? {} : { emit: this.#deps.emit }),
        ...(this.#deps.notifyAutonomousMessage === undefined ? {} : { notify: this.#deps.notifyAutonomousMessage }),
      });
    });
  }

  async openSeals(character: string, now: number): Promise<OpenedSeal[]> {
    const opened = await this.#deps.registry.openDueSeals(character, now);
    const config = this.#deps.registry.effectiveConfig(character);
    const user = resolveDisplayName(config.app.chat, this.#deps.env);
    return opened.map((sealed) => {
      this.#deps.emitEvent?.({ type: "threads_changed", character, thread: sealed.id });
      return { thread: sealed.id, reason: `${user} can see this thread and everything in it from now on. This wake is for giving them what you made.` };
    });
  }

  async runCompaction(character: string, _reason: CompactionReason): Promise<AutonomyActionResult> {
    return await this.#withForeground(async () => {
      const config = this.#deps.registry.effectiveConfig(character);
      return await runIdleCompaction(character, {
        config,
        cache: this.#deps.cache,
        rebuild: this.#deps.rebuild,
        engine: this.#engineReloader(),
      });
    });
  }

  async runDeepArchive(character: string): Promise<AutonomyActionResult> {
    return await this.#withForeground(async () => {
      const config = this.#deps.registry.effectiveConfig(character);
      return await runDeepIdleArchive(character, {
        config,
        cache: this.#deps.cache,
        rebuild: this.#deps.rebuild,
        engine: this.#engineReloader(),
        ...(this.#deps.notifyCompactionComplete === undefined
          ? {}
          : { notify: this.#deps.notifyCompactionComplete }),
      });
    });
  }

  #loopCalls(config: LoadedConfig, character: string, task: string, [first, loop]: readonly [string, string]): {
    generate: (request: SidecarRequest, phase: ToolPhase, signal: AbortSignal) => Promise<GenerateResponse>;
    imageLimits: () => ImageLimits | undefined;
  } {
    let imageLimits: ImageLimits | undefined;
    return {
      imageLimits: () => imageLimits,
      generate: async (request, phase, signal) => {
        labelAccountedCall(request, config, character, first);
        imageLimits = imageLimitsFor(request.sdk, request.model);
        let round = 0;
        const { response, fallbacks } = await generate(request, this.#generateDeps(config), signal, {
          tools: {
            ...phase,
            beforeTurn: async (call) => {
              labelAccountedCall(call, config, character, round++ === 0 ? first : loop);
              imageLimits = imageLimitsFor(call.sdk, call.model);
              await phase.beforeTurn?.(call);
            },
          },
        });
        for (const event of fallbacks) {
          shoreLog.warn(
            `shore: ${task} for ${character} rotated ${event.from.name} → ` +
            `${event.to?.name ?? "(none)"}: ${event.reason}`,
          );
        }
        return response;
      },
    };
  }

  #transcripts(source: TranscriptSource, character: string): { recordTranscript?: (round: TranscriptRound) => void } {
    const store = this.#deps.callStore;
    return store === undefined ? {} : {
      recordTranscript: (round) => {
        recordTranscript(store, {
          source,
          character,
          callType: round.callType,
          iteration: round.iteration,
          response: round.response,
          tools: round.captured,
        });
      },
    };
  }

  async #withForeground<T>(run: () => Promise<T>): Promise<T> {
    const foreground = async () => {
      const end = this.#deps.beginForeground?.();
      try {
        return await run();
      } finally {
        end?.();
      }
    };
    return await (this.#deps.runActivity?.(foreground) ?? foreground());
  }

  #threadCompaction(): CompactionRunner {
    const runner = compactionRunner({ cache: this.#deps.cache, rebuild: this.#deps.rebuild });
    return {
      ...runner,
      run: async (character, effective, thread) => {
        const pass = async () => await runner.run(character, effective, thread);
        return await (this.#deps.runActivity?.(pass) ?? pass());
      },
    };
  }

  #engineReloader(): PostArchiveEngine {
    return {
      reload: async (name: string) => {
        const engine = await this.#deps.registry.getOrCreate(name);
        await engine.reload();
      },
    };
  }

  #generateDeps(config: LoadedConfig): GenerateDeps {
    return {
      providers: this.#deps.providers,
      config,
      ...(this.#deps.env === undefined ? {} : { env: this.#deps.env }),
    };
  }
}

async function runLoopTool(
  ctx: ToolContext,
  config: LoadedConfig,
  imageLimits: ImageLimits | undefined,
  use: { id: string; name: string; input: unknown },
  tools: readonly ToolDefinition[] | undefined,
): Promise<LoopToolResult> {
  const exec: ToolExecution = {
    sendDirect: () => {},
    ctx,
    limits: toolLimitsFrom(config.app.tools, config.app.subagents.agents),
    imageLimits,
    now: () => new Date().toISOString(),
    newMessageId: () => `m_${crypto.randomUUID()}`,
    schemas: schemasFrom(tools),
  };
  const run = await runToolUse(use, exec);
  return { output: run.output, isError: run.isError, block: run.block };
}

export type CompactionGenerate = (
  request: SidecarRequest,
  model: { provider_key: string; api_key_env?: string | undefined },
  character: string,
) => Promise<GenerateResponse>;

export function compactionGenerate(deps: GenerateDeps, { foreground = false }: { foreground?: boolean } = {}): CompactionGenerate {
  return async (request, model, character) => {
    labelAccountedCall(request, deps.config, character, "label", foreground);
    const { response, fallbacks } = await generateViaStream(
      request,
      { providerKey: model.provider_key, apiKeyEnv: model.api_key_env },
      deps,
      {},
    );
    for (const event of fallbacks) {
      shoreLog.warn(
        `shore: a segment label for ${character} rotated ${event.from.name} → ` +
          `${event.to?.name ?? "(none)"}: ${event.reason}`,
      );
    }
    return response;
  };
}

function labelAccountedCall(
  request: SidecarRequest,
  config: LoadedConfig,
  character: string,
  callType: string,
  foreground = false,
): void {
  const options = request.provider_options;
  request.context = {
    ...request.context,
    ledger: request.context?.ledger ?? rustJoin(config.dirs.data, "shore.db"),
    character,
    call_type: callType,
    foreground,
    thinking_enabled: options?.thinking_enabled === true,
    ...(options?.cache_ttl === undefined ? {} : { cache_ttl: options.cache_ttl }),
    ...(options?.reasoning_effort === undefined
      ? {}
      : { reasoning_effort: options.reasoning_effort }),
    usage: usageConfigView(config.app),
  };
}
