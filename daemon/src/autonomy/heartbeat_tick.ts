import { withConversation } from "../engine/lifecycle.ts";
import { characterDataDir, threadDataDir } from "../config/dirs.ts";
import { homeThreadOf, readThreadsIndex, threadRecord } from "../engine/threads.ts";
import { deriveContentFromBlocks } from "../engine/message_store.ts";
import { shoreLog } from "../log.ts";

import { buildAutonomousMessage } from "./heartbeat_shape.ts";
import {
  HEARTBEAT_TIME_LIMIT_MS,
  runHeartbeatToolLoop,
  type HeartbeatLoopDeps,
  type HeartbeatLoopResult,
  type HeartbeatRound,
} from "./heartbeat_loop.ts";
import { prepareHeartbeatRequest, type HeartbeatCutOff, type PrepareHeartbeatDeps, type PreparedHeartbeat } from "./heartbeat_request.ts";
import { recordHomeThrough, type HomeReader } from "./heartbeat_thread.ts";
import { deleteCharacterState, readCharacterState, writeCharacterState } from "../storage/store.ts";
import type { HeartbeatEventKind } from "./heartbeat_log.ts";
import type { AutonomyActionResult } from "./runner.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { Message } from "../engine/types.ts";
import { newMessageVersion } from "../engine/versions.ts";
import { nearMessageBudget } from "../engine/prompt.ts";
import { pruneTurns, replyVersions, WorkspaceRecorder, workspaceTurnsFor } from "../tools/workspace_turns.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import { budgetStopIn, describeError } from "../llm/errors.ts";
import { imageTierForModel } from "../llm/image_tokens.ts";
import { truncateSummary, type NotificationPicture } from "../notifications.ts";
import { pictureText } from "../engine/embeds.ts";
import { firstSentPicture, pictureProblems, sendPictures, type PictureSender } from "../handler/pictures.ts";
import { archiveTrimmedTurns, maybeCompact, threadShouldCompact, type CompactionRunner } from "../handler/turn.ts";
import { canArchiveTurns } from "../memory/compaction/plan.ts";
import { sentPicturesDir } from "../storage/sent_pictures.ts";
import type { CallBlock } from "../ledger/budget.ts";
import type { SidecarRequest, Usage } from "../llm/types.ts";
import type { ToolConversation } from "../handler/tool_context.ts";

export interface HeartbeatEngine extends HomeReader {
  readonly thread: string;
  appendMessage(msg: Message): Promise<void>;
  currentRevision(): number;
  turnCount(): number;
  reload(): Promise<void>;
  recoverInterruptedToolLoop(): Promise<number>;
}

export interface HeartbeatThreads {
  ensure(character: string): Promise<{ thread: string; created: boolean }>;
  engine(character: string, thread: string): Promise<HeartbeatEngine>;
}

export interface HeartbeatTickDeps
  extends PrepareHeartbeatDeps,
    Omit<
      HeartbeatLoopDeps,
      "character" | "wrapUpGrace" | "maxToolIterations" | "note" | "generate" | "dispatch" | "persist"
    > {
  generate: HeartbeatLoopDeps["generate"];
  dispatch: (...args: [...Parameters<HeartbeatLoopDeps["dispatch"]>, ToolConversation]) => ReturnType<HeartbeatLoopDeps["dispatch"]>;
  threads: HeartbeatThreads;
  emit?: (character: string, revision: number, msg: Message, thread: string) => void;
  threadsChanged?: (character: string, thread: string) => void;
  notify?: (title: string, body: string, picture?: NotificationPicture) => void;
  newId?: () => string;
  nowIso?: () => string;
  budgetBlockFor?: (request: SidecarRequest) => CallBlock | undefined;
  compaction?: CompactionRunner;
}

function shortPreview(text: string): string {
  return Array.from(text).slice(0, 80).join("");
}

const CUT_OFF_STATE = "heartbeat_cut_off.json";

function readCutOff(characterDir: string): HeartbeatCutOff | undefined {
  try {
    const raw = readCharacterState(characterDir, CUT_OFF_STATE);
    if (raw === undefined) return undefined;
    const { at, rounds, sent } = JSON.parse(raw) as Record<string, unknown>;
    if (typeof at !== "number" || typeof rounds !== "number" || typeof sent !== "boolean") return undefined;
    return { at, rounds, sent };
  } catch (error) {
    shoreLog.error(`shore: could not read the last heartbeat's cut-off at ${characterDir}: ${String(error)}`);
    return undefined;
  }
}

function settleCutOff(characterDir: string, cutOff: HeartbeatCutOff | undefined): void {
  try {
    if (cutOff === undefined) deleteCharacterState(characterDir, CUT_OFF_STATE);
    else writeCharacterState(characterDir, CUT_OFF_STATE, JSON.stringify(cutOff));
  } catch (error) {
    shoreLog.error(`shore: could not record the heartbeat's cut-off at ${characterDir}: ${String(error)}`);
  }
}

function noteTickFailure(
  character: string,
  loop: HeartbeatLoopResult,
  note: (kind: HeartbeatEventKind, detail: string) => void,
): void {
  const round = loop.failedRound ?? 0;

  if (loop.timedOut === true) {
    const limit = `${String(HEARTBEAT_TIME_LIMIT_MS / 60_000)}-minute limit`;
    shoreLog.warn(`shore: heartbeat for ${character} reached its ${limit} and was stopped on round ${round}`);
    note("timeout", `Heartbeat reached its ${limit} and was stopped on round ${round}`);
    return;
  }

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

export interface HeartbeatHome {
  thread: string;
  engine: Pick<HeartbeatEngine, "appendMessage" | "currentRevision">;
}

export async function persistHeartbeatMessage(
  character: string,
  request: SidecarRequest,
  loop: HeartbeatLoopResult,
  deps: Pick<HeartbeatTickDeps, "emit" | "notify" | "newId" | "nowIso">,
  note: (kind: HeartbeatEventKind, detail: string) => void,
  home: HeartbeatHome,
  pictures?: PictureSender,
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

  if (pictures !== undefined) msg.images.push(...await sendPictures([text], pictures));

  let persisted: Message | undefined;
  try {
    await home.engine.appendMessage(msg);
    persisted = msg;
    deps.emit?.(character, home.engine.currentRevision(), msg, home.thread);
  } catch (e) {
    shoreLog.error(
      `shore: heartbeat could not deliver the autonomous message for ${character} to ${home.thread}: ${String(e)}`,
    );
  }

  const shown = pictureText(msg.content, msg.images);
  deps.notify?.(`Shore - ${character}`, shown, firstSentPicture(msg.images));

  note("message_sent", `Autonomous message sent: ${shortPreview(shown)}`);
  return persisted;
}

function roundMessage(round: HeartbeatRound, request: SidecarRequest, deps: Pick<HeartbeatTickDeps, "newId" | "nowIso">): Message {
  const model = round.model === undefined || round.model === "" ? request.model : round.model;
  return {
    msg_id: (deps.newId ?? (() => `m_${crypto.randomUUID()}`))(),
    role: round.role,
    content: deriveContentFromBlocks(round.blocks, true),
    images: [],
    content_blocks: round.blocks,
    timestamp: (deps.nowIso ?? (() => new Date().toISOString()))(),
    ...(round.role === "assistant"
      ? {
          ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),
          ...(model === "" ? {} : { model }),
        }
      : round.blocks.every((block) => block.type === "tool_result") ? {} : { origin: "autonomous" as const }),
  };
}

function contextTokensOf(usage: Usage | undefined): number {
  return usage === undefined ? 0 : usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
}

async function tidyHeartbeatThread(
  character: string,
  config: LoadedConfig,
  engine: HeartbeatEngine,
  prepared: PreparedHeartbeat,
  usage: Usage | undefined,
  runner: CompactionRunner,
): Promise<void> {
  const compaction = config.app.memory.compaction;
  const active = engine.messages();
  const crowded = nearMessageBudget(active, prepared.messageBudget, imageTierForModel(prepared.modelId)) &&
    canArchiveTurns(active, compaction.keep_recent_turns);
  const index = await readThreadsIndex(config.dirs.data, character);
  const record = index === undefined ? undefined : threadRecord(index, engine.thread);
  if (record?.compaction === false) {
    if (crowded) await archiveTrimmedTurns(config.dirs.data, engine, character, characterWorkspace(config, character), compaction.keep_recent_turns, () => new Date().toISOString(), runner);
    return;
  }
  await maybeCompact(
    {
      autonomy: {
        shouldCompactNow: (_character, turns, tokens, full) => threadShouldCompact(config, turns, tokens, full === true),
        onCompactionComplete: () => {},
        onCompactionFailed: () => {},
      },
    },
    engine,
    character,
    config,
    config.dirs.data,
    contextTokensOf(usage),
    runner,
    crowded,
  );
}

export async function runHeartbeatTick(
  character: string,
  config: LoadedConfig,
  deps: HeartbeatTickDeps,
): Promise<AutonomyActionResult> {
  const events: { kind: HeartbeatEventKind; detail: string }[] = [];
  const note = (kind: HeartbeatEventKind, detail: string): void => {
    events.push({ kind, detail });
  };

  let engine: HeartbeatEngine;
  let home: HeartbeatEngine;
  try {
    const { thread, created } = await deps.threads.ensure(character);
    if (created) deps.threadsChanged?.(character, thread);
    engine = await deps.threads.engine(character, thread);
    home = await deps.threads.engine(character, await homeThreadOf(config.dirs.data, character));
  } catch (error) {
    shoreLog.error(`shore: heartbeat for ${character} could not open its thread: ${String(error)}`);
    note("call_failed", `Heartbeat thread could not be opened — ${truncateSummary(String(error), 200)}`);
    return { events };
  }
  const thread = engine.thread;

  return await withConversation(threadDataDir(config.dirs.data, character, thread), "turn", async (signal) => {
    const characterDir = characterDataDir(config.dirs.data, character);
    const cutOff = readCutOff(characterDir);
    const prepared = await prepareHeartbeatRequest(
      character,
      config,
      { thread, home: home.thread, history: engine, homeThread: home },
      { ...deps, ...(cutOff === undefined ? {} : { cutOff }) },
    );
    if (prepared === undefined) return { events };

    const blocked = (deps.budgetBlockFor ?? budgetBlockFor)(prepared.request);
    if (blocked !== undefined) {
      note("budget_paused", `Heartbeat paused before round 0 — ${blocked.summary}`);
      return { events };
    }

    await engine.appendMessage(prepared.opener);
    await engine.appendMessage(prepared.instructions);
    recordHomeThrough(characterDir, Date.parse(prepared.opener.timestamp));
    deps.emit?.(character, engine.currentRevision(), prepared.opener, thread);

    const workspace = characterWorkspace(config, character);
    const workspaceTurns = workspaceTurnsFor(config.dirs, character, workspace);
    const recorder = new WorkspaceRecorder(workspaceTurns);
    const known = new Set(replyVersions(engine.messages()));
    let reply: Message | undefined;
    const loop = await runHeartbeatToolLoop(prepared.request, {
      ...deps,
      dispatch: (name, input, toolUseId, tools) => deps.dispatch(name, input, toolUseId, tools, { ...prepared, recordWorkspaceWrite: recorder.track }),
      generate: (request, phase, loopSignal) => deps.generate(request, phase, AbortSignal.any([signal, loopSignal])),
      persist: async (round) => {
        const message = roundMessage(round, prepared.request, deps);
        await engine.appendMessage(message);
        if (message.role === "assistant") reply = message;
      },
      character,
      wrapUpGrace: config.app.behavior.autonomy.heartbeat.wrap_up_grace_rounds,
      maxToolIterations: prepared.maxToolIterations,
      note: (detail) => note("tool_use", detail),
      checkPictures: async (text) => await pictureProblems([text], workspace, signal),
    });
    if (loop.failedRound !== undefined) await engine.recoverInterruptedToolLoop();

    signal.throwIfAborted();
    if (reply !== undefined) deps.emit?.(character, engine.currentRevision(), { ...reply, origin: "assistant_reply" }, thread);
    const sent = await persistHeartbeatMessage(
      character,
      prepared.request,
      loop,
      deps,
      note,
      { thread: home.thread, engine: home },
      { workspace, dir: sentPicturesDir(config.dirs.data, character) },
    );
    const newest = replyVersions(engine.messages()).filter((version) => !known.has(version)).at(-1);
    if (newest === undefined) await recorder.discard();
    else {
      await recorder.settle(thread, newest);
      await pruneTurns(workspaceTurns, thread, engine.messages());
    }
    if (loop.timedOut === true) {
      settleCutOff(characterDir, { at: deps.now?.() ?? Date.now(), rounds: loop.failedRound ?? 0, sent: sent !== undefined });
    } else if (cutOff !== undefined && loop.failedRound !== 0) {
      settleCutOff(characterDir, undefined);
    }

    if (deps.compaction !== undefined) {
      try {
        await tidyHeartbeatThread(character, config, engine, prepared, loop.usage, deps.compaction);
      } catch (error) {
        shoreLog.warn(`shore: could not compact the heartbeat thread for ${character}: ${String(error)}`);
      }
    }

    return { events };
  });
}
