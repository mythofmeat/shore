import { withConversation } from "../engine/lifecycle.ts";
import { threadDataDir } from "../config/dirs.ts";
import { homeThreadOf } from "../engine/threads.ts";
import { shoreLog } from "../log.ts";

import { buildAutonomousMessage } from "./heartbeat_shape.ts";
import {
  runHeartbeatToolLoop,
  type HeartbeatLoopDeps,
  type HeartbeatLoopResult,
} from "./heartbeat_loop.ts";
import { prepareHeartbeatRequest, type PrepareHeartbeatDeps } from "./heartbeat_request.ts";
import type { HeartbeatEventKind } from "./heartbeat_log.ts";
import type { AutonomyActionResult } from "./runner.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { Message } from "../engine/types.ts";
import { newMessageVersion } from "../engine/versions.ts";
import { recordTurn, snapshotTree, workspaceTurnsFor } from "../tools/workspace_turns.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import { budgetStopIn, describeError } from "../llm/errors.ts";
import { truncateSummary } from "../notifications.ts";
import type { CallBlock } from "../ledger/budget.ts";
import type { SidecarRequest } from "../llm/types.ts";
import type { ToolConversation } from "../handler/tool_context.ts";

export interface HeartbeatEngine {
  readonly thread?: string;
  appendMessage(msg: Message): Promise<void>;
  currentRevision(): number;
}

export interface HeartbeatTickDeps
  extends PrepareHeartbeatDeps,
    Omit<
      HeartbeatLoopDeps,
      "character" | "wrapUpGrace" | "maxToolIterations" | "note" | "generate" | "dispatch"
    > {
  generate: HeartbeatLoopDeps["generate"];
  dispatch: (...args: [...Parameters<HeartbeatLoopDeps["dispatch"]>, ToolConversation]) => ReturnType<HeartbeatLoopDeps["dispatch"]>;
  engine?: (character: string, thread?: string) => Promise<HeartbeatEngine>;
  emit?: (character: string, revision: number, msg: Message, thread: string) => void;
  notify?: (title: string, body: string) => void;
  newId?: () => string;
  nowIso?: () => string;
  budgetBlockFor?: (request: SidecarRequest) => CallBlock | undefined;
}

function shortPreview(text: string): string {
  return Array.from(text).slice(0, 80).join("");
}

function noteTickFailure(
  character: string,
  loop: HeartbeatLoopResult,
  note: (kind: HeartbeatEventKind, detail: string) => void,
): void {
  const round = loop.failedRound ?? 0;

  const stop = budgetStopIn(loop.failure);
  if (stop !== undefined) {
    shoreLog.info(`shore: heartbeat for ${character} paused on round ${round}: ${stop.message}`);
    note("budget_paused", `Heartbeat paused on round ${round} — ${stop.summary ?? stop.message}`);
    return;
  }

  if (loop.failure === undefined) {
    shoreLog.error(`shore: heartbeat call for ${character} failed on round ${round}`);
    note(
      "call_failed",
      `Model call failed on round ${round} — tick ended early ` +
        `(shore trace calls for the provider's reason)`,
    );
    return;
  }

  const reason = truncateSummary(describeError(loop.failure), 200);
  shoreLog.error(`shore: heartbeat call for ${character} failed on round ${round}: ${reason}`);
  note("call_failed", `Model call failed on round ${round} — ${reason}`);
}

export async function persistHeartbeatMessage(
  character: string,
  request: SidecarRequest,
  loop: HeartbeatLoopResult,
  deps: Pick<HeartbeatTickDeps, "engine" | "emit" | "notify" | "newId" | "nowIso">,
  note: (kind: HeartbeatEventKind, detail: string) => void,
): Promise<Message | undefined> {
  if (loop.failedRound !== undefined) {
    noteTickFailure(character, loop, note);
    if (loop.sendMessageText === undefined && loop.images.length === 0) return undefined;
  } else if (loop.sendMessageText === undefined && loop.images.length === 0) {
    note("message_skipped", "Tick completed — no message sent");
    return undefined;
  }

  const text = loop.sendMessageText ?? "";
  shoreLog.info(
    `shore: heartbeat for ${character} sending a message (images=${loop.images.length})`,
  );

  const shape = buildAutonomousMessage(
    text,
    loop.images,
    request.provider_key,
    request.model === "" ? undefined : request.model,
    loop.thinking ?? [],
  );
  const msg: Message = {
    msg_id: (deps.newId ?? (() => `m_${crypto.randomUUID()}`))(),
    origin: "autonomous",
    role: "assistant",
    content: shape.content,
    images: shape.images.map((img) => ({
      path: img.path,
      ...(img.caption === undefined ? {} : { caption: img.caption }),
      ...(img.data === undefined ? {} : { data: img.data }),
    })),
    content_blocks: shape.contentBlocks,
    alternatives: [],
    ...(shape.providerKey === undefined ? {} : { provider_key: shape.providerKey }),
    ...(shape.model === undefined ? {} : { model: shape.model }),
    timestamp: (deps.nowIso ?? (() => new Date().toISOString()))(),
    version: newMessageVersion(),
  };

  let persisted: Message | undefined;
  if (deps.engine === undefined) {
    shoreLog.error(`shore: heartbeat for ${character} has no engine, message not persisted`);
  } else {
    try {
      const engine = await deps.engine(character);
      await engine.appendMessage(msg);
      persisted = msg;
      deps.emit?.(character, engine.currentRevision(), msg, engine.thread ?? request.context?.thread ?? "main");
    } catch (e) {
      shoreLog.error(
        `shore: heartbeat could not persist the autonomous message for ${character}: ${String(e)}`,
      );
    }
  }

  deps.notify?.(`Shore - ${character}`, msg.content);

  note("message_sent", `Autonomous message sent: ${shortPreview(msg.content)}`);
  return persisted;
}

export async function runHeartbeatTick(
  character: string,
  config: LoadedConfig,
  deps: HeartbeatTickDeps,
): Promise<AutonomyActionResult> {
  const thread = await homeThreadOf(config.dirs.data, character);
  if (deps.engine !== undefined) {
    let engine: HeartbeatEngine | undefined;
    let failure: unknown;
    try { engine = await deps.engine(character, thread); }
    catch (error) { failure = error; }
    deps = {
      ...deps,
      engine: async () => {
        if (engine === undefined) throw failure;
        return engine;
      },
    };
  }
  return await withConversation(threadDataDir(config.dirs.data, character, thread), "turn", async (signal) => {
    const events: { kind: HeartbeatEventKind; detail: string }[] = [];
    const note = (kind: HeartbeatEventKind, detail: string): void => {
      events.push({ kind, detail });
    };

    const prepared = await prepareHeartbeatRequest(character, config, { ...deps, thread });
    if (prepared === undefined) return { events };

    const blocked = (deps.budgetBlockFor ?? budgetBlockFor)(prepared.request);
    if (blocked !== undefined) {
      note("budget_paused", `Heartbeat paused before round 0 — ${blocked.summary}`);
      return { events };
    }

    const workspaceTurns = workspaceTurnsFor(config.dirs, character, characterWorkspace(config, character));
    const before = await snapshotTree(workspaceTurns);
    const loop = await runHeartbeatToolLoop(prepared.request, {
      ...deps,
      dispatch: (name, input, toolUseId, tools) => deps.dispatch(name, input, toolUseId, tools, prepared),
      generate: (request, phase, loopSignal) => deps.generate(request, phase, AbortSignal.any([signal, loopSignal])),
      character,
      wrapUpGrace: config.app.behavior.autonomy.heartbeat.wrap_up_grace_rounds,
      maxToolIterations: prepared.maxToolIterations,
      note: (detail) => note("tool_use", detail),
    });

    signal.throwIfAborted();
    const sent = await persistHeartbeatMessage(character, prepared.request, loop, deps, note);
    if (sent?.version !== undefined) await recordTurn(workspaceTurns, thread, sent.version, before);

    return { events };
  });
}
