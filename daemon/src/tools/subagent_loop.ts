import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { resolveDisplayName } from "../config/app.ts";
import {
  configView,
  resolveSubagentBaseModel,
  resolveSubagentModelSettings,
} from "../config/preferences.ts";
import { resolvedReplayPriorThinking, toRequestModel } from "../config/models.ts";
import { renderTemplate } from "../engine/prompt.ts";
import type { Message } from "../engine/types.ts";
import { credentialEntry } from "../handler/tool_context.ts";
import { anthropicToolLoopEvents } from "../llm/providers/anthropic_loop.ts";
import { genericToolLoopEvents } from "../llm/providers/generic_loop.ts";
import { capturedEvents, type CallRecorder } from "../llm/capture.ts";
import { beginCallAttempt, recordingStream } from "../ledger/record.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import { usageConfigView } from "../ledger/budget.ts";
import { BudgetBlocked } from "../llm/generate.ts";
import { buildRequestWithProviderKeys } from "../llm/request.ts";
import { consumeStream } from "../llm/stream.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  ToolDefinition,
} from "../llm/types.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import { rustJoin } from "../config/dirs.ts";
import {
  InvalidArgs,
  NotImplemented,
  toolLimitsFrom,
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
  subagentToolSubset,
  templateVars,
} from "./subagent.ts";
import { appendSubagentTrace } from "./subagent_trace.ts";
import { schemasFrom } from "./validate.ts";

const TAGGED_FRAMES = new Set([
  "stream_start",
  "stream_chunk",
  "stream_end",
  "tool_call",
  "tool_result",
  "send_image",
]);

export interface SubagentDeps {
  config: LoadedConfig;
  ctx: ToolContext;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  callStore?: CallRecorder | undefined;
  mcpRegistry?: Pick<McpRegistry, "namesMatching"> | undefined;
  sendDirect?: ((message: ServerMessage) => void) | undefined;
  conversation?: readonly Message[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  rid?: string | undefined;
  now?: (() => string) | undefined;
  newMessageId?: (() => string) | undefined;
}

export function subagentRunner(
  deps: SubagentDeps,
): (name: string, query: string, signal?: AbortSignal, toolUseId?: string) => Promise<string> {
  return async (name, query, signal, toolUseId) =>
    await runSubagent(deps, name, query, signal, toolUseId);
}

export async function runSubagent(
  deps: SubagentDeps,
  name: string,
  query: string,
  signal?: AbortSignal,
  toolUseId?: string,
): Promise<string> {
  const { config } = deps;
  const spec = config.app.subagents.get(name);
  if (spec === undefined) throw new NotImplemented(`ask_${name}`);

  const charName = deps.ctx.characterName;
  let catalogModel;
  try {
    catalogModel = resolveSubagentBaseModel(
      configView(config),
      charName,
      spec.model,
      (view, cacheDir, model, includeHidden) =>
        findEffectiveModel(view, cacheDir, model, includeHidden),
    );
  } catch (e) {
    throw new InvalidArgs(`subagent '${name}': ${String(e)}`);
  }
  if (catalogModel === undefined) throw new InvalidArgs(missingModelMessage(name, charName));

  const resolved = resolveSubagentModelSettings(config.dirs.data, charName, name, catalogModel);

  const provider = deps.providers[resolved.sdk];
  if (provider === undefined && resolved.sdk !== "anthropic") {
    throw new InvalidArgs(`unsupported sdk: ${resolved.sdk}`);
  }

  const displayName = resolveDisplayName(config.app.defaults, deps.env);
  const vars = templateVars(charName, displayName);

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
      system: [{ text: systemText, label: "system" }],
      tools,
      replay: resolvedReplayPriorThinking(resolved, config.app.memory.thinking.replay_prior_thinking),
    },
    deps.env ?? process.env,
  );

  const maxIterations = spec.max_iterations ?? resolved.maxToolIterations;
  const request: SidecarRequest = {
    ...built.request,
    ...(maxIterations === undefined ? {} : { max_tool_iterations: maxIterations }),
    context: {
      ledger: rustJoin(config.dirs.data, "ledger.db"),
      character: charName,
      call_type: "subagent",
      ...(built.api_key_name === undefined ? {} : { api_key_name: built.api_key_name }),
      thinking_enabled: built.request.provider_options?.thinking_enabled === true,
      usage: usageConfigView(config.app.usage),
      ...(deps.rid === undefined ? {} : { rid: deps.rid }),
    },
  };

  const send = taggedSink(name, deps.sendDirect, toolUseId);
  const messages: Message[] = [];
  const phase = toolPhase({
    sendDirect: send,
    ctx: nestedContext(deps.ctx, signal),
    limits: toolLimits(config),
    subagent: name,
    ...(deps.rid === undefined ? {} : { rid: deps.rid }),
    now: deps.now ?? (() => new Date().toISOString()),
    newMessageId: deps.newMessageId ?? (() => `m_${crypto.randomUUID()}`),
    schemas: schemasFrom(request.tools),
  }, messages);

  const trace = async (outcome: { result?: string; error?: string }): Promise<void> => {
    if (toolUseId === undefined) return;
    try {
      await appendSubagentTrace(deps.ctx.characterDataDir, {
        subagent: name,
        parent_tool_use_id: toolUseId,
        ...(deps.rid === undefined ? {} : { rid: deps.rid }),
        model: request.model,
        messages,
        ...outcome,
      });
    } catch (e) {
      console.warn(`shore: failed to record subagent '${name}' trace: ${String(e)}`);
    }
  };

  const events: AsyncIterable<StreamEvent> =
    request.sdk === "anthropic" || provider === undefined
      ? capturedEvents(deps.callStore, request, () =>
          anthropicToolLoopEvents(request, phase, signal),
        )
      : genericToolLoopEvents(provider, request, phase, signal);

  const blocked = budgetBlockFor(request);
  if (blocked) {
    await trace({ error: blocked.message });
    throw new BudgetBlocked(blocked.message, blocked.scope, blocked.reset_at);
  }
  const initialAttempt = beginCallAttempt(request.context, request);
  let outcome;
  try {
    outcome = await consumeStream(recordingStream(
      request.context,
      request,
      events,
      initialAttempt,
      (continued, callType) => {
        const next = { ...continued, context: { ...continued.context!, call_type: callType } };
        const nextBlock = budgetBlockFor(next);
        if (nextBlock) {
          throw new BudgetBlocked(nextBlock.message, nextBlock.scope, nextBlock.reset_at);
        }
        return beginCallAttempt(next.context, next);
      },
    ), {
      regen: false,
      sink: send,
    });
  } catch (e) {
    const failure = e instanceof Error ? e.message : String(e);
    await trace({ error: failure });
    throw e;
  }

  if ("err" in outcome) {
    const failure = describe(outcome.err);
    await trace({ error: failure });
    throw new InvalidArgs(failure);
  }
  await trace({ result: outcome.ok.content });
  return outcome.ok.content;
}

export function nestedContext(ctx: ToolContext, signal?: AbortSignal): ToolContext {
  const { runSubagent: _dropped, ...rest } = ctx;
  return { ...rest, ...(signal === undefined ? {} : { signal }) };
}

export function taggedSink(
  name: string,
  sendDirect: ((message: ServerMessage) => void) | undefined,
  taskId?: string,
): (message: ServerMessage) => void {
  if (sendDirect === undefined) return () => {};
  return (message) => {
    if (!TAGGED_FRAMES.has(message.type)) {
      sendDirect(message);
      return;
    }
    sendDirect({
      ...message,
      subagent: name,
      ...(taskId === undefined ? {} : { task_id: taskId }),
    } as ServerMessage);
  };
}

function describe(err: { kind: string; message?: string }): string {
  return err.message === undefined ? err.kind : `${err.kind}: ${err.message}`;
}

function toolLimits(config: LoadedConfig): ToolLimitsView {
  return toolLimitsFrom(config.app.tools, config.app.subagents);
}
