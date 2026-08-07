/**
 * Running a sub-agent's nested tool loop.
 *
 * Ported from `run`, `resolve_spec_and_model`, `build_request` and
 * `spawn_forwarder` in `crates/daemon/src/tools/subagent.rs`. What the
 * sub-agent is *told* — prompt macros, transcript, tool subset — is
 * `subagent.ts`; this drives the loop it is told into.
 *
 * `ask_<name>(query)` runs a whole second conversation on a (typically
 * cheaper) model, over a subset of the tools, and returns only its final text.
 * The bulky intermediate tool results never enter the primary model's context
 * and the primary model's tool surface stays small — that is the whole win.
 *
 * # The recursion cap is structural, twice over
 *
 * The nested loop runs against a context with `runSubagent` **removed**, so a
 * hallucinated `ask_*` answers `NotImplemented` instead of recursing. That is
 * the backstop. The primary guarantee is that `subagentToolSubset` only offers
 * tools from the static registry, and `ask_*` is never in it — so a
 * well-behaved model has no affordance to hallucinate from in the first place.
 *
 * # The forwarder
 *
 * The nested loop's frames are tagged with the sub-agent's name and relayed to
 * the client, so the UI renders the nested loop instead of freezing on the
 * `ask_<name>` call. It is a *view*: the intermediate tool results it shows
 * still never enter the primary model's context. A background context (a
 * heartbeat, dreaming) has no live turn to stream into, so its frames are
 * dropped — the Rust drained them off a bounded channel for the same reason
 * they are simply not forwarded here.
 *
 * # The system prompt goes top-level
 *
 * The Rust forked on SDK: Anthropic-cache providers took the prompt as an
 * inline `role:"system"` entry, everyone else took it top-level. Its stated
 * reason was to mirror dreaming and compaction, which must keep an instruction
 * at a fixed index so the chat prefix they extend stays byte-stable.
 *
 * That reason does not reach here. A sub-agent request is built from scratch —
 * one user message, no prefix to protect and nothing that can shift. What the
 * fork cost was real, though: inline on Anthropic means the adapter wraps the
 * prompt in `<system_instruction>` and merges it into the preceding user turn,
 * so it lost the system role and landed *after* the question. Top-level is
 * cached either way; `tsDefaultPlacement` anchors a breakpoint on the system
 * prefix.
 */

import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { resolveDisplayName } from "../config/app.ts";
import { configView } from "../config/preferences.ts";
import { resolvedReplayPriorThinking, toRequestModel } from "../config/models.ts";
import { renderTemplate } from "../engine/prompt.ts";
import type { Message } from "../engine/types.ts";
import { credentialEntry } from "../handler/tool_context.ts";
import { anthropicToolLoopEvents } from "../llm/providers/anthropic_loop.ts";
import { genericToolLoopEvents } from "../llm/providers/generic_loop.ts";
import { recordingStream } from "../ledger/record.ts";
import { buildRequestWithProviderKeys } from "../llm/request.ts";
import { consumeStream } from "../llm/stream.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  ToolDefinition,
} from "../llm/types.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { ToolCallEntry } from "../diagnostics.ts";
import { rustJoin } from "../config/dirs.ts";
import {
  InvalidArgs,
  NotImplemented,
  type ToolContext,
  type ToolLimitsView,
} from "./dispatch.ts";
import { toolPhase } from "./execute.ts";
import type { McpRegistry, McpToolDef } from "./mcp_registry.ts";
import { ALL_TOOLS } from "./registry.ts";
import {
  expandPromptMacros,
  MAX_HISTORY_MESSAGES,
  missingModelMessage,
  resolveSubagentModel,
  subagentToolSubset,
  templateVars,
} from "./subagent.ts";

/** The frame types a nested loop emits that carry a `subagent` tag. */
const TAGGED_FRAMES = new Set([
  "stream_start",
  "stream_chunk",
  "stream_end",
  "tool_call",
  "tool_result",
  "send_image",
]);

export interface SubagentDeps {
  /** The effective config for the character that is delegating. */
  config: LoadedConfig;
  /** The delegating turn's tool context. The nested one is derived from it. */
  ctx: ToolContext;
  /** One adapter per dialect, as the turn driver has them. */
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  /** Live MCP connections, for expanding `mcp__server__*` grants. */
  mcpRegistry?: Pick<McpRegistry, "namesMatching"> | undefined;
  /**
   * Where the nested loop's frames go, already destined for the issuing
   * session. Absent for a background context, which has no live turn: the
   * sub-agent still runs and still returns its summary.
   */
  sendDirect?: ((message: ServerMessage) => void) | undefined;
  /** The tool-call ring. Push-only, like everywhere else that writes it. */
  diagnostics: { push: (entry: ToolCallEntry) => void };
  /**
   * A bounded tail of this turn's conversation, for `{{active_history: n}}`.
   * Empty for a background context, where the macro degrades to nothing.
   */
  conversation?: readonly Message[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Echoed onto every frame the nested loop emits. */
  rid?: string | undefined;
  now?: (() => string) | undefined;
  newMessageId?: (() => string) | undefined;
}

/**
 * The `runSubagent` a tool context is given.
 *
 * Returns the sub-agent's final text. Errors are `ToolError`s so the calling
 * model is *told* what went wrong — a sub-agent that cannot be resolved or
 * cannot reach its model is a failed tool call, not a failed turn.
 */
export function subagentRunner(
  deps: SubagentDeps,
): (name: string, query: string, signal?: AbortSignal) => Promise<string> {
  return async (name, query, signal) => await runSubagent(deps, name, query, signal);
}

export async function runSubagent(
  deps: SubagentDeps,
  name: string,
  query: string,
  signal?: AbortSignal,
): Promise<string> {
  const { config } = deps;
  const spec = config.app.subagents.get(name);
  // The same error an unregistered tool gets. A config that names no such
  // sub-agent and a model that invented one are indistinguishable here, and
  // both are "that name is not callable".
  if (spec === undefined) throw new NotImplemented(`ask_${name}`);

  const modelName = resolveSubagentModel(spec.model, {
    ...(config.app.defaults.subagent_model === undefined
      ? {}
      : { subagent_model: config.app.defaults.subagent_model }),
    ...(config.app.defaults.model === undefined ? {} : { model: config.app.defaults.model }),
  });
  if (modelName === undefined) throw new InvalidArgs(missingModelMessage(name));

  let resolved;
  try {
    resolved = findEffectiveModel(configView(config), config.dirs.cache, modelName, true);
  } catch (e) {
    throw new InvalidArgs(`subagent '${name}' model '${modelName}': ${String(e)}`);
  }

  // Anthropic runs through its own loop, which owns its SDK client and needs
  // no adapter; everything else is driven against one from the table.
  const provider = deps.providers[resolved.sdk];
  if (provider === undefined && resolved.sdk !== "anthropic") {
    throw new InvalidArgs(`unsupported sdk: ${resolved.sdk}`);
  }

  const charName = deps.ctx.characterName;
  const displayName = resolveDisplayName(config.app.defaults, deps.env);
  const vars = templateVars(charName, displayName);

  // Two passes, and the order is the security boundary. The authored prompt is
  // trusted and gets `{{char}}`/`{{#if}}` substitution; the macros expand after
  // it and their output is never re-scanned, so a chat message containing the
  // literal `{{file: ~/.ssh/id_rsa}}` reaches the sub-agent as text and not as
  // a file read. See `subagent.ts`.
  const systemText = expandPromptMacros(renderTemplate(spec.prompt, vars), {
    characterDataDir: deps.ctx.characterDataDir,
    workspaceDir: deps.ctx.workspaceDir,
    history: (deps.conversation ?? []).slice(-MAX_HISTORY_MESSAGES),
    charName,
    userName: displayName,
  });

  const mcp = deps.mcpRegistry;
  const subset = subagentToolSubset(
    spec.tools,
    ALL_TOOLS,
    vars,
    renderTemplate,
    mcp === undefined
      ? undefined
      : {
          namesMatching: (allowed) =>
            mcp.namesMatching(allowed).map((t: McpToolDef) => ({
              name: t.full_name,
              description: t.description,
              parameters: t.input_schema,
            })),
        },
    (unknown) =>
      console.warn(`shore: subagent '${name}' references unknown tool ${unknown}; skipping`),
  );
  // `parameters` here, `input_schema` on the wire. One rename, at the one
  // place the two vocabularies meet.
  const tools: ToolDefinition[] = subset.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));

  const entry = config.providers.get(resolved.providerKey);
  const built = buildRequestWithProviderKeys(
    toRequestModel(resolved),
    entry === undefined ? undefined : credentialEntry(entry),
    {
      messages: [{ role: "user", content: [{ type: "text", text: query }] }],
      // Top-level, for every provider. See the module doc.
      system: [{ text: systemText, label: "system" }],
      tools,
      replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),
    },
    deps.env ?? process.env,
  );

  // The cap is the sub-agent's own when it set one, else the model's. Absent
  // means unlimited, so the model ending cleanly is the only exit.
  const maxIterations = spec.max_iterations ?? resolved.maxToolIterations;
  const request: SidecarRequest = {
    ...built.request,
    ...(maxIterations === undefined ? {} : { max_tool_iterations: maxIterations }),
    context: {
      ledger: rustJoin(config.dirs.data, "ledger.db"),
      character: charName,
      // Its own call type, so a sub-agent's spend is attributable rather than
      // folded into the turn that delegated.
      call_type: "subagent",
      ...(built.api_key_name === undefined ? {} : { api_key_name: built.api_key_name }),
      thinking_enabled: built.request.provider_options?.thinking_enabled === true,
      ...(deps.rid === undefined ? {} : { rid: deps.rid }),
    },
  };

  const send = taggedSink(name, deps.sendDirect);
  const phase = toolPhase({
    sendDirect: send,
    // The nested context, with `runSubagent` gone. Everything else is the
    // parent's, so a sub-agent reaches the same workspace, the same MCP
    // servers and the same ledger.
    ctx: nestedContext(deps.ctx, signal),
    limits: toolLimits(config),
    diagnostics: deps.diagnostics,
    ...(deps.rid === undefined ? {} : { rid: deps.rid }),
    now: deps.now ?? (() => new Date().toISOString()),
    newMessageId: deps.newMessageId ?? (() => `m_${crypto.randomUUID()}`),
  });

  const events: AsyncIterable<StreamEvent> =
    request.sdk === "anthropic" || provider === undefined
      ? anthropicToolLoopEvents(request, phase, signal)
      : genericToolLoopEvents(provider, request, phase, signal);

  const outcome = await consumeStream(recordingStream(request.context, request, events), {
    regen: false,
    sink: send,
  });
  if ("err" in outcome) throw new InvalidArgs(describe(outcome.err));
  return outcome.ok.content;
}

/**
 * The parent context with `runSubagent` removed.
 *
 * Deleting the key rather than setting it `undefined`: an absent field is what
 * `dispatch.ts` reads as "not wired here", and under
 * `exactOptionalPropertyTypes` the two are not the same value.
 */
export function nestedContext(ctx: ToolContext, signal?: AbortSignal): ToolContext {
  const { runSubagent: _dropped, ...rest } = ctx;
  return { ...rest, ...(signal === undefined ? {} : { signal }) };
}

/**
 * Tag each frame with the sub-agent's name on the way to the client.
 *
 * Only the six frame types that carry the field; a `phase` or an `error` from
 * a nested loop is left alone, matching `ServerMessage::set_subagent`. With no
 * client channel the frames are dropped — there is no live turn to render
 * them, and the sub-agent's summary is what the caller is waiting for.
 */
export function taggedSink(
  name: string,
  sendDirect: ((message: ServerMessage) => void) | undefined,
): (message: ServerMessage) => void {
  if (sendDirect === undefined) return () => {};
  return (message) => {
    sendDirect(
      TAGGED_FRAMES.has(message.type)
        ? ({ ...message, subagent: name } as ServerMessage)
        : message,
    );
  };
}

/** A stream failure, as the calling model is told about it. */
function describe(err: { kind: string; message?: string }): string {
  return err.message === undefined ? err.kind : `${err.kind}: ${err.message}`;
}

/**
 * `[tools]` as {@link toolPhase} reads it.
 *
 * The same shape `handler/generation.ts` builds for a chat turn. A sub-agent's
 * tools run under the same deadline and the same result cap as the primary's:
 * the limits are the daemon's, not the turn's.
 */
function toolLimits(config: LoadedConfig): ToolLimitsView {
  const cfg = config.app.tools;
  const overrides: Record<string, { max_result_chars?: number; timeout_ms?: number }> = {};
  for (const [toolName, o] of cfg.config) {
    overrides[toolName] = {
      ...(o.max_result_chars === undefined ? {} : { max_result_chars: o.max_result_chars }),
      ...(o.timeout === undefined ? {} : { timeout_ms: o.timeout.asMillis() }),
    };
  }
  return {
    max_result_chars: cfg.max_result_chars,
    timeout_ms: cfg.timeout.asMillis(),
    config: overrides,
  };
}
