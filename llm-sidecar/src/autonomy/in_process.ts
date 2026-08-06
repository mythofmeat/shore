/**
 * Running an autonomy action in this process, instead of asking the daemon to.
 *
 * The replacement for `RpcAutonomyExecutor`. That one exists because the three
 * things a tick can decide to do all reached the filesystem, MCP and sub-agents
 * — none of which lived on this side — so each became a call back over the
 * daemon's socket. All three have ported, so each becomes a function call.
 *
 * # This class holds almost nothing
 *
 * Every action is already a module: `heartbeat_tick.ts`, `idle_compaction.ts`,
 * `deep_archive.ts`. What is left here is the wiring each one needs and cannot
 * assemble for itself — the character's effective config, its conversation
 * engine, the provider adapters, the tool surface — and one translation per
 * action. Anything that looks like a decision in this file is a bug in it.
 *
 * # Where `set_next_wake` comes from
 *
 * Not from here. The clock a heartbeat moves belongs to `CharacterAutonomy`,
 * which is also what calls this, so the scheduling function arrives per tick as
 * {@link TickHooks} rather than being reached for. The alternative — this
 * holding the service that holds this — is the same wiring with a cycle in it.
 */

import { runHeartbeatTick } from "./heartbeat_tick.ts";
import { runIdleCompaction } from "./idle_compaction.ts";
import { runDeepIdleArchive } from "./deep_archive.ts";
import type { LastRequestCache } from "./last_request.ts";
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

/** What every action needs, assembled once. */
export interface InProcessExecutorDeps {
  /** Effective config and conversation engines, both per character. */
  registry: CharacterRegistry;
  /** The body a heartbeat reuses and a compaction extends. */
  cache: LastRequestCache;
  /** Provider adapters by sdk, as `server.ts` assembles them. */
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  /** Push a delivered autonomous message to connected clients. */
  emit?: (character: string, revision: number, msg: Message) => void;
  /**
   * Desktop notifications, one hook per event rather than one hook.
   *
   * `[notifications.events]` has a toggle per event, so which event an action
   * files under is the difference between a switch the user set doing what they
   * meant and doing nothing. The Rust chose per call site —
   * `AutonomousMessage` at `manager.rs:1837`, `CompactionComplete` at
   * `manager.rs:625` — and this is the same choice made in the same place.
   */
  notifyAutonomousMessage?: (title: string, body: string) => void;
  notifyCompactionComplete?: (title: string, body: string) => void;
  /** The curated `shore log --heartbeat` view. */
  callStore?: Pick<CallStore, "recordTranscript">;
  /** What the tool context needs beyond the config. */
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
        // The call type is per round — the first is the tick, the rest are its
        // loop — and it reaches the ledger through the request's own context,
        // which is also where the character and the budget live.
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
          // `undefined` ends the loop. A heartbeat that cannot reach its model
          // has nothing to retry against and the next tick is an hour away at
          // worst, so this is a log line rather than a thrown tick.
          console.error(
            `shore: heartbeat call for ${character} failed on round ${iteration}: ${String(e)}`,
          );
          return undefined;
        }
      },

      // Neither truncated nor deadlined, which is the Rust's
      // `dispatch_heartbeat_tools` exactly: it called `dispatch_tool` bare,
      // while the chat path went through the `[tools]` caps. Worth knowing
      // rather than worth fixing here — a heartbeat's only bound on a wedged
      // or enormous tool result is the loop's own 30-minute deadline, and
      // changing that is a behaviour change, not a port.
      dispatch: async (name, input) => {
        try {
          const value = await dispatchTool(name, input as Record<string, unknown>, toolCtx);
          return {
            output: typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
            isError: false,
            value,
          };
        } catch (e) {
          // A tool's failure is text the model reads, with a flag — never a
          // throw. The variant prefixes (`invalid args: `, `io: `) are part of
          // that contract, so it is the message rather than `String(e)`.
          return { output: e instanceof Error ? e.message : String(e), isError: true };
        }
      },

      scheduleNextWake: (hours, reason) => {
        // The clock applies the bound and answers with what it used, so the
        // model is told the hour it actually got rather than the one it asked
        // for.
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
    // Only the idle trigger's pass is this executor's. `max_turns` fires inline
    // from the turn that crossed the threshold — the generation driver runs it
    // with the config for the turn it is finishing, which is not something this
    // can reconstruct after the fact.
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
      engine: { reload: async (name: string) => void (await this.#deps.registry.getOrCreate(name)) },
      // No notification hook, and not an oversight. The Rust's
      // `compaction_complete` for this path is fired from *inside* the pass,
      // where the "ran but wrote no memory" outcome exists; that half has not
      // ported (see `memory/compaction/run.ts`). Notifying from here would send
      // "compaction complete" for the outcome that most needs a different
      // sentence — the one where the conversation was not archived.
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
      engine: { reload: async (name: string) => void (await this.#deps.registry.getOrCreate(name)) },
      ...(this.#deps.notifyCompactionComplete === undefined
        ? {}
        : { notify: this.#deps.notifyCompactionComplete }),
    }, coveredTurnCount);
  }

  #generateDeps(config: LoadedConfig): GenerateDeps {
    return {
      providers: this.#deps.providers,
      config,
      ...(this.#deps.env === undefined ? {} : { env: this.#deps.env }),
    };
  }

  /**
   * The compaction seam's `generate`, which is told its model rather than
   * resolving one.
   *
   * Passed through rather than re-derived: the pass built the request against
   * that exact model, and `resolveModelForRequest` would have to find it again
   * in the static catalog — which a discovered model or a `provider:model_id`
   * pin is never in. Re-resolving would silently drop those passes to a single
   * key.
   */
  #compactionDeps(config: LoadedConfig): {
    generate: (
      request: SidecarRequest,
      model: { provider_key: string; api_key_env?: string | undefined },
      character: string,
    ) => Promise<GenerateResponse>;
    tools?: Omit<ToolContextDeps, "runSubagent">;
  } {
    return {
      generate: async (request, model, character) => {
        request.context = { ...request.context, character } as never;
        const { response, fallbacks } = await generateWithCredentialFallback(
          request,
          { providerKey: model.provider_key, apiKeyEnv: model.api_key_env },
          this.#generateDeps(config),
        );
        for (const event of fallbacks) {
          console.warn(
            `shore: compaction for ${character} rotated ${event.from.name} → ` +
              `${event.to?.name ?? "(none)"}: ${event.reason}`,
          );
        }
        return response;
      },
      ...(this.#deps.tools === undefined ? {} : { tools: this.#deps.tools }),
    };
  }
}
