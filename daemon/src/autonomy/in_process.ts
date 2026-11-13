import { shoreLog } from "../log.ts";

import type { LoopToolResult, TranscriptRound } from "./background_loop.ts";
import { runIdleCompaction } from "./idle_compaction.ts";
import { runDeepIdleArchive } from "./deep_archive.ts";
import type { LastRequestCache } from "../cache/last_request.ts";
import { reloadAndApplyDeferred, repoint, type PostArchiveEngine } from "./post_archive.ts";
import type { AutonomyActionResult, AutonomyExecutor, DreamActionResult, DreamWindow, OpenedSeal, WakeHooks, WakeResult, WakeRun } from "./runner.ts";
import { addDiaryNote } from "./diary.ts";
import { runWake } from "./wake.ts";
import { sealedFilesDir } from "../handler/sealed_thread.ts";
import { DREAM_CALL_TYPE, DREAM_LOOP_CALL_TYPE, DREAM_TOOL_THREAD, runDreamPass } from "../memory/dreaming/run.ts";
import type { ToolContext } from "../tools/dispatch.ts";
import type { CompactionReason } from "./tick.ts";
import type { CharacterRegistry } from "../characters.ts";
import { resolveDisplayName } from "../config/app.ts";
import { characterDataDir, rustJoin } from "../config/dirs.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { usageConfigView } from "../ledger/budget.ts";
import type { Message } from "../engine/types.ts";
import { generate, generateViaStream } from "../llm/generate.ts";
import type { FrameSink } from "../llm/stream.ts";
import type { GenerateDeps } from "../llm/generate.ts";
import type { ToolLoopOptions, GenerateResponse, SidecarProvider, SidecarRequest, ToolDefinition } from "../llm/types.ts";
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
  runActivity?: <T>(run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}

export class InProcessAutonomyExecutor implements AutonomyExecutor {
  readonly #deps: InProcessExecutorDeps;

  constructor(deps: InProcessExecutorDeps) {
    this.#deps = deps;
  }

  async runWake(character: string, wake: WakeRun, hooks: WakeHooks): Promise<WakeResult> {
    return await this.#withForeground(async () => {
      const config = this.#deps.registry.effectiveConfig(character);
      const calls = this.#loopCalls(config, character, "wake", ["heartbeat", "heartbeat_tool_loop"]);
      const { wakeInThread, ...rest } = this.#deps.tools ?? {};
      const handsOn = wakeInThread === undefined || wake.fired.some((firing) => firing.from !== undefined) ? {} : { wakeInThread };
      let toolCtx: ReturnType<typeof buildToolContext> | undefined;
      return await runWake(character, config, { thread: wake.thread, fired: wake.fired, limitMs: wake.limitMs }, {
        rebuild: this.#deps.rebuild,
        interrupted: wake.interrupted,
        compaction: this.#threadCompaction(config),
        ...(this.#deps.env === undefined ? {} : { env: this.#deps.env }),
        news: (wrappingUp) => hooks.news(wrappingUp),
        newsHeard: () => { hooks.newsHeard(); },
        generate: calls.generate,
        dispatch: async (name, input, toolUseId, tools, conversation) => {
          toolCtx ??= buildToolContext(config, config.dirs.data, character, { ...rest, ...handsOn, thread: conversation.thread, conversation: conversation.conversation });
          const ctx = { ...await toolCtx, ...(conversation.recordWorkspaceWrite === undefined ? {} : { recordWorkspaceWrite: conversation.recordWorkspaceWrite }) };
          return await runLoopTool(ctx, config, calls.imageLimits(), { id: toolUseId ?? `wk_${crypto.randomUUID()}`, name, input }, tools);
        },
        ...this.#transcripts("heartbeat", character),
        ownThread: async (name) => await this.#deps.registry.ensureOwnThread(name),
        engine: async (name, thread) => this.#deps.registry.listThreads(name).some((record) => record.id === thread) && (wake.thread === undefined || thread !== this.#deps.registry.ownThread(name))
          ? await this.#deps.registry.getOrCreate(name, thread)
          : await this.#deps.registry.sealedEngine(name, thread),
        sealed: async (name, thread) => {
          const sealed = this.#deps.registry.sealedThreads(name).find((each) => each.id === thread);
          return sealed === undefined ? undefined : { sealed, filesDir: await sealedFilesDir(config, name, thread) };
        },
        threadModel: (name, thread) => this.#deps.registry.listThreads(name).find((record) => record.id === thread)?.chat_model,
        threadsChanged: (name, thread) => { this.#deps.emitEvent?.({ type: "threads_changed", character: name, thread }); },
        ...(this.#deps.emit === undefined ? {} : { emit: this.#deps.emit }),
        ...(this.#deps.notifyAutonomousMessage === undefined ? {} : { notify: this.#deps.notifyAutonomousMessage }),
      });
    });
  }

  async openSeals(character: string, now: number): Promise<OpenedSeal[]> {
    const opened = await this.#deps.registry.openDueSeals(character, now);
    const config = this.#deps.registry.effectiveConfig(character);
    const user = resolveDisplayName(config.app.defaults, this.#deps.env);
    return opened.map((sealed) => {
      addDiaryNote(characterDataDir(config.dirs.data, character), {
        at: now, thread: sealed.id, source: "shore", text: `The seal on "${sealed.label}" came off. Its thread, \`${sealed.id}\`, is in ${user}'s thread list from now on, and you are being woken there.`,
      });
      this.#deps.emitEvent?.({ type: "threads_changed", character, thread: sealed.id });
      return { thread: sealed.id, reason: `${user} can see this thread and everything in it from now on. This wake is for giving them what you made.` };
    });
  }

  async runCompaction(character: string, reason: CompactionReason): Promise<AutonomyActionResult> {
    return await this.#withForeground(async () => {
      if (reason !== "idle") {
        return {
          events: [],
          failed: `compaction reason ${reason} is not the autonomy loop's to run`,
        };
      }
      const config = this.#deps.registry.effectiveConfig(character);
      return await runIdleCompaction(character, {
        config,
        cache: this.#deps.cache,
        rebuild: this.#deps.rebuild,
        run: this.#compactionDeps(config),
        engine: this.#engineReloader(),
      });
    });
  }

  async runDeepArchive(
    character: string,
    coveredTurnCount: number,
  ): Promise<AutonomyActionResult> {
    return await this.#withForeground(async () => {
      const config = this.#deps.registry.effectiveConfig(character);
      return await runDeepIdleArchive(character, {
        config,
        cache: this.#deps.cache,
        rebuild: this.#deps.rebuild,
        run: this.#compactionDeps(config),
        engine: this.#engineReloader(),
        ...(this.#deps.notifyCompactionComplete === undefined
          ? {}
          : { notify: this.#deps.notifyCompactionComplete }),
      }, coveredTurnCount);
    });
  }

  async runDream(character: string, start: DreamWindow): Promise<DreamActionResult> {
    const config = this.#deps.registry.effectiveConfig(character);
    const calls = this.#loopCalls(config, character, "dream", [DREAM_CALL_TYPE, DREAM_LOOP_CALL_TYPE]);
    const activity = async <T>(run: () => Promise<T>): Promise<T> =>
      await (this.#deps.runActivity?.(run, start.signal) ?? run());
    let toolCtx: Promise<ToolContext> | undefined;
    const pass = await runDreamPass(character, config, start, {
      generate: calls.generate,
      dispatch: async (scoped, name, input, toolUseId, tools, writes) => await activity(async () => {
        start.signal.throwIfAborted();
        toolCtx ??= this.#dreamToolContext(scoped, character, start.signal);
        const ctx = { ...await toolCtx, recordWorkspaceWrite: writes };
        return await runLoopTool(ctx, scoped, calls.imageLimits(), { id: toolUseId ?? `dr_${crypto.randomUUID()}`, name, input }, tools);
      }),
      ...this.#transcripts("dreaming", character),
      refreshHome: async () => await activity(async () => {
        const deps = { config, cache: this.#deps.cache, rebuild: this.#deps.rebuild, engine: this.#engineReloader() };
        await reloadAndApplyDeferred(character, deps, "dream");
        await repoint(character, deps, "prompt_reload");
      }),
      ...(this.#deps.env === undefined ? {} : { env: this.#deps.env }),
    });
    return { events: pass.events, dream: pass.outcome };
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

  #transcripts(source: "heartbeat" | "dreaming", character: string): { recordTranscript?: (round: TranscriptRound) => void } {
    const store = this.#deps.callStore;
    if (store === undefined) return {};
    return {
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

  async #dreamToolContext(config: LoadedConfig, character: string, signal: AbortSignal): Promise<ToolContext> {
    const {
      wakeInThread: _handOff,
      sealThread: _seal,
      startThread: _start,
      editThread: _edit,
      deferEdit: _defer,
      mcpRegistry: _mcp,
      mcpToolDefs: _mcpDefs,
      imageGenerator: _images,
      ...tools
    } = this.#deps.tools ?? {};
    const ctx = await buildToolContext(config, config.dirs.data, character, { ...tools, conversation: [], signal });
    delete ctx.imageGenConfig;
    ctx.thread = DREAM_TOOL_THREAD;
    return ctx;
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

  #threadCompaction(config: LoadedConfig): CompactionRunner {
    const runner = compactionRunner({ ...this.#compactionDeps(config), cache: this.#deps.cache, rebuild: this.#deps.rebuild });
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

  #compactionDeps(config: LoadedConfig): {
    env?: NodeJS.ProcessEnv;
    generate: CompactionGenerate;
    tools?: ToolContextDeps;
  } {
    return {
      generate: compactionGenerate(this.#generateDeps(config)),
      ...(this.#deps.env === undefined ? {} : { env: this.#deps.env }),
      ...(this.#deps.tools === undefined ? {} : { tools: this.#deps.tools }),
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
    limits: toolLimitsFrom(config.app.tools, config.app.subagents),
    ...(imageLimits === undefined ? {} : { imageLimits }),
    now: () => new Date().toISOString(),
    newMessageId: () => `m_${crypto.randomUUID()}`,
    schemas: schemasFrom(tools),
  };
  const run = await runToolUse(use, exec, []);
  return {
    output: run.output,
    isError: run.isError,
    block: run.block,
    ...(run.value === undefined ? {} : { value: run.value }),
  };
}

export type CompactionGenerate = (
  request: SidecarRequest,
  model: { provider_key: string; api_key_env?: string | undefined },
  character: string,
  sink?: FrameSink,
  tools?: ToolPhase,
  options?: ToolLoopOptions,
  signal?: AbortSignal,
) => Promise<GenerateResponse>;

export function compactionGenerate(deps: GenerateDeps, { foreground = false, callType = "compaction" }: { foreground?: boolean; callType?: "compaction" | "label" } = {}): CompactionGenerate {
  return async (request, model, character, sink, tools, options, signal) => {
    labelAccountedCall(request, deps.config, character, callType, foreground);
    const { response, fallbacks } = await generateViaStream(
      request,
      { providerKey: model.provider_key, apiKeyEnv: model.api_key_env },
      deps,
      { ...(sink === undefined ? {} : { sink }), ...(tools === undefined ? {} : { tools }), ...(options === undefined ? {} : { toolLoop: options }), ...(signal === undefined ? {} : { signal }) },
    );
    for (const event of fallbacks) {
      shoreLog.warn(
        `shore: compaction for ${character} rotated ${event.from.name} → ` +
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
    usage: usageConfigView(config.app.usage),
  };
}
