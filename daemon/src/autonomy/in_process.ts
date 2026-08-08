import { runHeartbeatTick } from "./heartbeat_tick.ts";
import { runIdleCompaction } from "./idle_compaction.ts";
import { runDeepIdleArchive } from "./deep_archive.ts";
import type { LastRequestCache } from "../cache/last_request.ts";
import type { PostArchiveEngine } from "./post_archive.ts";
import type { AutonomyActionResult, AutonomyExecutor, TickHooks } from "./runner.ts";
import type { CompactionReason } from "./tick.ts";
import type { CharacterRegistry } from "../characters.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { Message } from "../engine/types.ts";
import { generate, generateWithCredentialFallback } from "../llm/generate.ts";
import type { GenerateDeps } from "../llm/generate.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../llm/types.ts";
import type { ToolContextDeps } from "../handler/tool_context.ts";
import { buildToolContext } from "../handler/tool_context.ts";
import { dispatchTool } from "../tools/dispatch.ts";
import type { CallStore } from "../call_store.ts";
import { recordTranscript } from "../transcript_capture.ts";

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
}

export class InProcessAutonomyExecutor implements AutonomyExecutor {
  readonly #deps: InProcessExecutorDeps;

  constructor(deps: InProcessExecutorDeps) {
    this.#deps = deps;
  }

  async runHeartbeatTick(character: string, hooks: TickHooks): Promise<AutonomyActionResult> {
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

      generate: async (request, iteration, callType) => {
        request.context = { ...request.context, character, call_type: callType } as never;
        try {
          const { response, fallbacks } = await generate(request, this.#generateDeps(config));
          for (const event of fallbacks) {
            console.warn(
              `shore: heartbeat for ${character} rotated ${event.from.name} → ` +
                `${event.to?.name ?? "(none)"}: ${event.reason}`,
            );
          }
          return response;
        } catch (e) {
          console.error(
            `shore: heartbeat call for ${character} failed on round ${iteration}: ${String(e)}`,
          );
          return undefined;
        }
      },

      dispatch: async (name, input) => {
        try {
          const value = await dispatchTool(name, input as Record<string, unknown>, toolCtx);
          return {
            output: typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
            isError: false,
            value,
          };
        } catch (e) {
          return { output: e instanceof Error ? e.message : String(e), isError: true };
        }
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
  }

  async runCompaction(character: string, reason: CompactionReason): Promise<AutonomyActionResult> {
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
  }

  async runDeepArchive(
    character: string,
    coveredTurnCount: number,
  ): Promise<AutonomyActionResult> {
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
) => Promise<GenerateResponse>;

export function compactionGenerate(deps: GenerateDeps): CompactionGenerate {
  return async (request, model, character) => {
    request.context = { ...request.context, character } as never;
    const { response, fallbacks } = await generateWithCredentialFallback(
      request,
      { providerKey: model.provider_key, apiKeyEnv: model.api_key_env },
      deps,
    );
    for (const event of fallbacks) {
      console.warn(
        `shore: compaction for ${character} rotated ${event.from.name} → ` +
          `${event.to?.name ?? "(none)"}: ${event.reason}`,
      );
    }
    return response;
  };
}

function withoutSubagent(tools: ToolContextDeps): Omit<ToolContextDeps, "runSubagent"> {
  const { runSubagent: _dropped, ...rest } = tools;
  return rest;
}
