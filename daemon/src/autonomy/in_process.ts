import { shoreLog } from "../log.ts";

import { runHeartbeatTick } from "./heartbeat_tick.ts";
import { runIdleCompaction } from "./idle_compaction.ts";
import { runDeepIdleArchive } from "./deep_archive.ts";
import type { LastRequestCache } from "../cache/last_request.ts";
import type { PostArchiveEngine } from "./post_archive.ts";
import type { AutonomyActionResult, AutonomyExecutor, TickHooks } from "./runner.ts";
import type { CompactionReason } from "./tick.ts";
import type { CharacterRegistry } from "../characters.ts";
import { rustJoin } from "../config/dirs.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { usageConfigView } from "../ledger/budget.ts";
import type { Message } from "../engine/types.ts";
import { generate, generateViaStream } from "../llm/generate.ts";
import { DEFAULT_BACKOFF_BASE_MS, DEFAULT_MAX_RETRIES } from "../llm/fallback.ts";
import type { FrameSink } from "../llm/stream.ts";
import type { GenerateDeps } from "../llm/generate.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../llm/types.ts";
import type { ToolContextDeps } from "../handler/tool_context.ts";
import { buildToolContext } from "../handler/tool_context.ts";
import { toolLimitsFrom } from "../tools/dispatch.ts";
import type { CallStore } from "../call_store.ts";
import { recordTranscript } from "../transcript_capture.ts";
import { runToolUse, type ToolExecution } from "../tools/execute.ts";
import { schemasFrom } from "../tools/validate.ts";

export interface InProcessExecutorDeps {
  registry: CharacterRegistry;
  cache: LastRequestCache;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  emit?: (character: string, revision: number, msg: Message) => void;
  notifyAutonomousMessage?: (title: string, body: string) => void;
  notifyCompactionComplete?: (title: string, body: string) => void;
  callStore?: Pick<CallStore, "recordTranscript">;
  tools?: ToolContextDeps;
  env?: NodeJS.ProcessEnv;
  beginForeground?: () => () => void;
}

export class InProcessAutonomyExecutor implements AutonomyExecutor {
  readonly #deps: InProcessExecutorDeps;

  constructor(deps: InProcessExecutorDeps) {
    this.#deps = deps;
  }

  async runHeartbeatTick(character: string, hooks: TickHooks): Promise<AutonomyActionResult> {
    return await this.#withForeground(async () => {
      const config = this.#deps.registry.effectiveConfig(character);
      const toolCtx = await buildToolContext(
        config,
        config.dirs.data,
        character,
        this.#deps.tools ?? {},
      );

      return await runHeartbeatTick(character, config, {
        cache: this.#deps.cache,
        ...(this.#deps.env === undefined ? {} : { env: this.#deps.env }),

      generate: async (request, _iteration, callType) => {
        labelAccountedCall(request, config, character, callType);
        const { response, fallbacks } = await generate(request, this.#generateDeps(config));
        for (const event of fallbacks) {
          shoreLog.warn(
            `shore: heartbeat for ${character} rotated ${event.from.name} → ` +
              `${event.to?.name ?? "(none)"}: ${event.reason}`,
          );
        }
        return response;
      },

      dispatch: async (name, input, toolUseId, tools) => {
        const exec: ToolExecution = {
          sendDirect: () => {},
          ctx: toolCtx,
          limits: toolLimitsFrom(config.app.tools, config.app.subagents),
          now: () => new Date().toISOString(),
          newMessageId: () => `m_${crypto.randomUUID()}`,
          schemas: schemasFrom(tools),
        };
        const run = await runToolUse(
          { id: toolUseId ?? `hb_${crypto.randomUUID()}`, name, input },
          exec,
          [],
        );
        return {
          output: run.window?.output ?? run.raw,
          isError: run.isError,
          block: run.block,
          ...(run.value === undefined ? {} : { value: run.value }),
        };
      },

      scheduleNextWake: (hours, reason) => {
        const used = hooks.scheduleNextWake(hours, reason);
        return `Scheduled next moment in ${used.toFixed(1)} hours.`;
      },

      ...(this.#deps.callStore === undefined
        ? {}
        : {
            recordTranscript: (round) => {
              const store = this.#deps.callStore;
              if (store === undefined) return;
              recordTranscript(store, {
                source: "heartbeat",
                character,
                callType: round.callType,
                iteration: round.iteration,
                response: round.response,
                tools: round.captured,
              });
            },
          }),

      engine: async (name) => await this.#deps.registry.getOrCreate(name),
      ...(this.#deps.emit === undefined ? {} : { emit: this.#deps.emit }),
      ...(this.#deps.notifyAutonomousMessage === undefined
        ? {}
        : { notify: this.#deps.notifyAutonomousMessage }),
      });
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
        run: this.#compactionDeps(config),
        engine: this.#engineReloader(),
        ...(this.#deps.notifyCompactionComplete === undefined
          ? {}
          : { notify: this.#deps.notifyCompactionComplete }),
      }, coveredTurnCount);
    });
  }

  async #withForeground<T>(run: () => Promise<T>): Promise<T> {
    const end = this.#deps.beginForeground?.();
    try {
      return await run();
    } finally {
      end?.();
    }
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
      retry: {
        maxRetries: config.app.advanced.max_retries ?? DEFAULT_MAX_RETRIES,
        backoffBaseMs:
          config.app.advanced.retry_backoff?.asMillis() ?? DEFAULT_BACKOFF_BASE_MS,
      },
      ...(this.#deps.env === undefined ? {} : { env: this.#deps.env }),
    };
  }

  #compactionDeps(config: LoadedConfig): {
    generate: CompactionGenerate;
    tools?: Omit<ToolContextDeps, "runSubagent">;
  } {
    return {
      generate: compactionGenerate(this.#generateDeps(config)),
      ...(this.#deps.tools === undefined ? {} : { tools: withoutSubagent(this.#deps.tools) }),
    };
  }
}

export type CompactionGenerate = (
  request: SidecarRequest,
  model: { provider_key: string; api_key_env?: string | undefined },
  character: string,
  sink?: FrameSink,
) => Promise<GenerateResponse>;

export function compactionGenerate(deps: GenerateDeps): CompactionGenerate {
  return async (request, model, character, sink) => {
    labelAccountedCall(request, deps.config, character, "compaction");
    const { response, fallbacks } = await generateViaStream(
      request,
      { providerKey: model.provider_key, apiKeyEnv: model.api_key_env },
      deps,
      sink === undefined ? {} : { sink },
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
): void {
  const options = request.provider_options;
  request.context = {
    ...request.context,
    ledger: request.context?.ledger ?? rustJoin(config.dirs.data, "ledger.db"),
    character,
    call_type: callType,
    thinking_enabled: options?.thinking_enabled === true,
    ...(options?.cache_ttl === undefined ? {} : { cache_ttl: options.cache_ttl }),
    ...(options?.reasoning_effort === undefined
      ? {}
      : { reasoning_effort: options.reasoning_effort }),
    usage: usageConfigView(config.app.usage),
  };
}

function withoutSubagent(tools: ToolContextDeps): Omit<ToolContextDeps, "runSubagent"> {
  const { runSubagent: _dropped, ...rest } = tools;
  return rest;
}
