import type { RebuildDeps } from "../cache/rebuild.ts";
import { resolveDisplayName, toolEnabled, toolGrants } from "../config/app.ts";
import { characterDataDir, threadDataDir } from "../config/dirs.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { applyBackgroundSettings, configView, resolveChatModelForCharacter } from "../config/preferences.ts";
import { withConversation } from "../engine/lifecycle.ts";
import { deriveContentFromBlocks, isToolResultOnly } from "../engine/message_store.ts";
import { estimateHistoryTokens, formatWallClock, lengthPhrase, nearMessageBudget, statusesText } from "../engine/prompt.ts";
import { Texts } from "../texts/texts.ts";
import { sealedThreads, type SealedThread } from "../engine/sealed_list.ts";
import { NO_PRIOR_CONTEXT } from "../engine/segments.ts";
import { homeThread, isWakeOpener, readThreadsIndex, threadActivities, threadActivityNow, threadsTheCharacterSees, type ThreadsIndex } from "../engine/threads.ts";
import type { Message, MessageNote } from "../engine/types.ts";
import { buildChatShapeRequestFromDisk } from "../handler/context.ts";
import { inReadingOrder, type SentMessage } from "../handler/wire_messages.ts";
import { required } from "../util/required.ts";
import { thinkingEnabled } from "../handler/generation.ts";
import { cacheTtlSecs } from "../llm/request.ts";
import { pictureProblems, type PictureSender } from "../handler/pictures.ts";
import type { ToolConversation } from "../handler/tool_context.ts";
import { archiveTrimmedTurns, maybeCompact, threadShouldCompact, type CompactionRunner } from "../handler/turn.ts";
import { usageConfigView, type CallBlock } from "../ledger/budget.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import { hostZone } from "../ledger/zoned.ts";
import { budgetStopIn, describeError } from "../llm/errors.ts";
import { imageTierForModel } from "../llm/image_tokens.ts";
import type { GenerateResponse, SidecarRequest } from "../llm/types.ts";
import { shoreLog } from "../log.ts";
import { canArchiveTurns } from "../memory/compaction/plan.ts";
import { applyDeferredEdits } from "../memory/deferred_edits.ts";
import { truncateSummary, type NotificationPicture } from "../notifications.ts";
import { sentPicturesDir } from "../storage/sent_pictures.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { pruneTurns, replyVersions, WorkspaceRecorder, workspaceTurnsFor } from "../tools/workspace_turns.ts";
import { backgroundModelRequest, backgroundTaskModel } from "./background_model.ts";
import type { WakeEventKind } from "./wake_log.ts";
import { runBackgroundLoop, type BackgroundLoopDeps, type BackgroundLoopResult, type LoopRound } from "./background_loop.ts";
import { presence } from "./presence.ts";
import { byTrigger, WAKE_QUIET_MS, type TriggerFiring, type WakeNews, type WakeResult } from "./runner.ts";
import { sealedListNote, sealedWakeNote } from "./sealed_notes.ts";
import { threadDigest, type ThreadReader } from "./thread_digest.ts";
import { Outbox, postElsewhere, postMessage, reachableThreads } from "./outbox.ts";
import { pushRefusal, type PushOutcome } from "./push.ts";
import { spanPhrase, timeLeftPhrase, triggerFiredNote, wakeNewsNote } from "./wake_shape.ts";
import { recordWakeEnd, stopOf, wakeRecord, wakeStopNote, WakeWords, type WakeEnding } from "./wake_record.ts";
import { keptWorkingSummary, withoutWakeWorking } from "./wake_working.ts";

const LONGEST_WRAP_UP_MS = 15 * 60_000;

export interface WakeEngine extends ThreadReader {
  readonly thread: string;
  appendMessage(msg: Message): Promise<void>;
  currentRevision(): number;
  turnCount(): number;
  userTurnCount(): number;
  reload(): Promise<void>;
  recoverInterruptedToolLoop(reason: string): Promise<number>;
  saveNotes(sent: readonly SentMessage[]): Promise<void>;
}

export interface Wake {
  thread: string;
  fired: readonly TriggerFiring[];
  limitMs: number;
}

export interface SealedWake {
  sealed: SealedThread;
  filesDir: string;
}

export interface WorkingLog {
  engine: Pick<WakeEngine, "thread" | "appendMessage" | "messages" | "reload" | "recoverInterruptedToolLoop" | "saveNotes">;
  label: string;
}

export interface WakeDeps extends Pick<BackgroundLoopDeps, "recordTranscript" | "newsHeard"> {
  rebuild: RebuildDeps;
  generate: (...args: Parameters<BackgroundLoopDeps["generate"]>) => Promise<GenerateResponse>;
  dispatch: (...args: [...Parameters<BackgroundLoopDeps["dispatch"]>, ToolConversation]) => ReturnType<BackgroundLoopDeps["dispatch"]>;
  engine(character: string, thread: string): Promise<WakeEngine | undefined>;
  threadModel(character: string, thread: string): string | undefined;
  interrupted?: () => boolean;
  sealed?: (character: string, thread: string) => Promise<SealedWake | undefined>;
  workingLog?: (character: string) => Promise<WorkingLog | undefined>;
  news?: (wrappingUp: boolean) => WakeNews[];
  emit?: (character: string, revision: number, msg: Message, thread: string) => void;
  notify?: (title: string, body: string, picture?: NotificationPicture) => void;
  push?: (message: string) => Promise<PushOutcome>;
  budgetBlockFor?: (request: SidecarRequest) => CallBlock | undefined;
  compaction?: CompactionRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeZone?: string;
  newId?: () => string;
  nowIso?: () => string;
}

type Note = (kind: WakeEventKind, detail: string) => void;

export function wrapUpMsFor(limitMs: number): number {
  return Math.min(LONGEST_WRAP_UP_MS, Math.floor(limitMs / 6));
}

export function wakeWrapUpText(texts: Texts, msLeft: number, rounds: number, userName: string): string | undefined {
  return texts.render("wrap_up", { time_left: timeLeftPhrase(msLeft), last_round: rounds === 1 ? "yes" : undefined, rounds: String(rounds), user: userName });
}

export function wakeStoppedNote(texts: Texts, ending: WakeEnding, userName: string, limitMs: number, fired: readonly TriggerFiring[]): string | undefined {
  switch (ending.why) {
    case "interrupted":
      return texts.render("stopped_interrupted", { user: userName, quiet: spanPhrase(WAKE_QUIET_MS), triggers: fired.every(byTrigger) ? "yes" : undefined });
    case "time":
      return texts.render("stopped_time", { limit: spanPhrase(limitMs) });
    case "rounds":
      return texts.render("stopped_rounds");
    case "failed":
      return texts.render("stopped_failed", { error: ending.error });
  }
}

export function leadingWakeTurns(messages: readonly Message[]): number {
  const turns = messages.filter((message) => message.role === "user" && !isToolResultOnly(message));
  const written = turns.findIndex((message) => !isWakeOpener(message));
  return written === -1 ? turns.length : written;
}

export async function lastWroteNote(
  texts: Texts,
  dataDir: string,
  character: string,
  index: ThreadsIndex | undefined,
  here: string,
  userName: string,
  nowMs: number,
): Promise<string | undefined> {
  if (index === undefined) return undefined;
  const home = homeThread(index);
  const activity = await threadActivities(dataDir, character, index.threads.map((thread) => thread.id));
  let latest: { id: string; label: string | undefined; at: number } | undefined;
  for (const thread of threadsTheCharacterSees(index.threads)) {
    const at = Date.parse(activity.get(thread.id)?.last_user ?? "");
    if (Number.isNaN(at) || (latest !== undefined && at <= latest.at)) continue;
    latest = { id: thread.id, label: thread.label, at };
  }
  if (latest === undefined) return undefined;
  const values = { user: userName, length: lengthPhrase((nowMs - latest.at) / 1000), thread: latest.id, label: latest.label };
  return texts.render(latest.id === here ? "last_wrote_here" : latest.id === home ? "last_wrote_home" : "last_wrote_side", values);
}

function noteFailure(character: string, round: number, failure: unknown, note: Note): void {
  const stop = budgetStopIn(failure);
  if (stop !== undefined) {
    shoreLog.info(`shore: wake for ${character} paused on round ${round}: ${stop.message}`);
    note("budget_paused", `Wake paused on round ${round} — ${stop.summary ?? stop.message}`);
    return;
  }
  const reason = truncateSummary(describeError(failure), 200);
  shoreLog.error(`shore: wake call for ${character} failed on round ${round}: ${reason}`);
  note("call_failed", `Model call failed on round ${round} — ${reason}`);
}

export function noteOutcome(character: string, loop: Pick<BackgroundLoopResult, "failedRound" | "failure" | "timedOut">, nothingSent: boolean, note: Note): void {
  if (loop.failedRound !== undefined && loop.timedOut !== true) noteFailure(character, loop.failedRound, loop.failure, note);
  else if (nothingSent && loop.failedRound === undefined) note("message_skipped", "Wake completed — no message sent");
}

export function roundMessage(round: LoopRound, request: SidecarRequest, deps: Pick<WakeDeps, "newId" | "nowIso">): Message {
  const model = round.model === undefined || round.model === "" ? request.model : round.model;
  return {
    msg_id: (deps.newId ?? (() => `m_${crypto.randomUUID()}`))(),
    role: round.role,
    content: deriveContentFromBlocks(round.blocks, true),
    images: [],
    content_blocks: round.blocks,
    alternatives: [],
    timestamp: (deps.nowIso ?? (() => new Date().toISOString()))(),
    ...(round.role === "assistant"
      ? {
          ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),
          ...(model === "" ? {} : { model }),
        }
      : round.blocks.every((block) => block.type === "tool_result") ? {} : { origin: "autonomous" as const }),
  };
}

async function keepWorking(log: WorkingLog, message: Message, notes?: MessageNote[]): Promise<void> {
  try {
    await log.engine.appendMessage(message);
    if (notes !== undefined) await log.engine.saveNotes([{ msg_id: message.msg_id, notes }]);
  } catch (error) {
    shoreLog.warn(`shore: could not keep a wake's working in "${log.engine.thread}": ${String(error)}`);
  }
}

export async function runWake(character: string, config: LoadedConfig, wake: Wake, deps: WakeDeps): Promise<WakeResult> {
  const events: { kind: WakeEventKind; detail: string }[] = [];
  const characterDir = characterDataDir(config.dirs.data, character);
  const engine = await deps.engine(character, wake.thread);
  if (engine === undefined) {
    events.push({ kind: "call_failed", detail: `Wake skipped: no thread "${wake.thread}"` });
    return { events };
  }
  const seal = await deps.sealed?.(character, wake.thread);
  const thread = engine.thread;
  const log = seal === undefined ? await deps.workingLog?.(character) : undefined;
  if (log?.engine.thread === thread) {
    events.push({ kind: "call_failed", detail: `Wake skipped: "${thread}" keeps the working from wakes` });
    return { events };
  }
  const { recordTranscript: _recorded, emit: _emitted, notify: _announced, compaction: _compacted, ...unheard } = deps;
  const heard: WakeDeps = seal === undefined ? deps : unheard;
  const note: Note = (kind, detail) => {
    if (seal === undefined) events.push({ kind, detail });
    else if (kind !== "tool_use") events.push({ kind, detail: kind === "message_sent" ? "A message was left in a sealed thread" : detail });
  };

  let afterwards: (() => Promise<void>) | undefined;
  const result = await withConversation(threadDataDir(config.dirs.data, character, thread), "turn", async (signal): Promise<WakeResult> => {
    const index = await readThreadsIndex(config.dirs.data, character);
    const home = homeThread(index);
    if (index?.threads.some((each) => each.id === thread && each.on_hold === true) === true) {
      note("call_failed", `Wake skipped: "${thread}" is on hold`);
      return { events };
    }
    const chat = resolveChatModelForCharacter(
      configView(config),
      character,
      (view, cacheDir, name, includeHidden) => findEffectiveModel(view, cacheDir, name, includeHidden),
      deps.threadModel(character, thread),
    );
    if (chat === undefined) {
      note("call_failed", "Wake skipped: no chat model resolves");
      return { events };
    }
    let texts: Texts;
    try {
      texts = Texts.of(config);
    } catch (error) {
      note("call_failed", `Wake skipped: ${(error as Error).message}`);
      return { events };
    }
    const resolved = applyBackgroundSettings(config.dirs.data, character, "wake", chat);
    const configured = backgroundTaskModel(config, character);
    const maxToolRounds = (configured ?? resolved).maxToolRounds;
    const nowMs = deps.now?.() ?? Date.now();
    const timeZone = deps.timeZone ?? hostZone();
    const userName = resolveDisplayName(config.app.chat, deps.env);
    const wrapUpMs = wrapUpMsFor(wake.limitMs);
    const workspace = characterWorkspace(config, character);
    const lastUser = Date.parse(threadActivityNow(config.dirs.data, character, thread).last_user ?? "");
    if (thread !== home && !(nowMs - lastUser < cacheTtlSecs(resolved) * 1000)) {
      try {
        await applyDeferredEdits(characterDir, workspace, thread);
      } catch (error) {
        shoreLog.warn(`shore: could not refresh the prompt files of ${character}/${thread} before a wake: ${String(error)}`);
      }
    }
    const rendered = texts.render("wake", {
      now: formatWallClock(nowMs, timeZone),
      user: userName,
      thread,
      home,
      time_limit: spanPhrase(wake.limitMs),
      wrap_up_after: spanPhrase(wake.limitMs - wrapUpMs),
      max_rounds: maxToolRounds === undefined ? undefined : String(maxToolRounds),
      resume_after: spanPhrase(WAKE_QUIET_MS),
      working_thread: log?.engine.thread,
      working_here: log === undefined ? "yes" : undefined,
      send_message: toolEnabled(config.app.tools, "send_message") ? "yes" : undefined,
    });
    const record = wakeRecord(characterDir, thread);
    const status = presence(config.dirs.data);
    const fired = wake.fired.flatMap((firing) => triggerFiredNote(texts, firing, timeZone) ?? []);
    const setOffBy = [...new Set(wake.fired.map((firing) => firing.name).filter((name) => name !== ""))].join(", ");
    const setOff = [...fired, seal === undefined ? undefined : sealedWakeNote(texts, seal.sealed, seal.filesDir, userName, timeZone), rendered].filter((part) => part !== undefined);
    const newId = deps.newId ?? (() => `m_${crypto.randomUUID()}`);
    const id = newId();
    const opener = (text: string): Message => ({
      msg_id: id,
      role: "user",
      origin: "autonomous",
      content: text,
      images: [],
      content_blocks: [{ type: "text", text }],
      alternatives: [],
      timestamp: new Date(nowMs).toISOString(),
    });
    const shown = opener([
      texts.always("wake_opener"),
      await threadDigest(texts, engine, record.through, userName, timeZone),
      record.stopped === undefined ? undefined : wakeStopNote(texts, record.stopped, userName, timeZone),
      await lastWroteNote(texts, config.dirs.data, character, index, thread, userName, nowMs).catch(() => undefined),
      status === undefined || status.statuses.length === 0 ? undefined : texts.render("wake_status", { user: userName, statuses: statusesText(texts, status, nowMs) }),
      seal === undefined ? sealedListNote(texts, sealedThreads(characterDir), timeZone) : undefined,
      ...setOff,
    ].filter((part) => part !== undefined).join("\n\n"));

    let built: Awaited<ReturnType<typeof buildChatShapeRequestFromDisk>>;
    try {
      built = await buildChatShapeRequestFromDisk(character, characterDir, config, resolved, [shown], NO_PRIOR_CONTEXT, {
        mcpToolDefs: deps.rebuild.mcpRegistry.toolDefsFiltered(toolGrants(config.app.tools)),
        thread,
        timeZone,
        ...(deps.env === undefined ? {} : { env: deps.env }),
      });
    } catch (error) {
      shoreLog.warn(`shore: wake for ${character} in ${thread} could not build its request: ${String(error)}`);
      note("call_failed", `Wake could not build its request: ${String(error)}`);
      return { events };
    }
    const { request, override } = backgroundModelRequest(built.request, config, character, deps.env, configured);
    request.context = {
      ...request.context,
      ledger: `${config.dirs.data}/shore.db`,
      usage: usageConfigView(config.app),
      character,
      thread,
      call_type: "wake",
      ...(setOffBy === "" ? {} : { trigger: setOffBy }),
      thinking_enabled: thinkingEnabled(request.provider_options),
      ...(seal === undefined ? {} : { sealed: true }),
    };
    const blocked = (deps.budgetBlockFor ?? budgetBlockFor)(request);
    if (blocked !== undefined) {
      note("budget_paused", `Wake paused before round 0 — ${blocked.summary}`);
      return { events };
    }

    const later = [texts.always("wake_opener"), ...fired].join("\n\n");
    const read = inReadingOrder([...required(built.sent.find((sent) => sent.msg_id === id)).notes, { place: "instead", text: shown.content }]);
    if (log === undefined) {
      await engine.appendMessage({ ...opener([texts.always("wake_opener"), ...setOff].join("\n\n")), shown_later: later });
      await engine.saveNotes([{ msg_id: id, notes: read }]);
    } else {
      await engine.appendMessage(opener(later));
      await keepWorking(log, { ...opener([texts.always("wake_opener_kept", { thread }), ...setOff].join("\n\n")), msg_id: newId() }, read);
    }
    const working: Message[] = [];
    const conversation = { thread, conversation: [shown] };
    const pictures: PictureSender = { workspace, dir: sentPicturesDir(config.dirs.data, character) };
    const workspaceTurns = workspaceTurnsFor(config.dirs, character, workspace);
    const recorder = new WorkspaceRecorder(workspaceTurns);
    const known = new Set([...replyVersions(engine.messages()), ...replyVersions(log?.engine.messages() ?? [])]);
    const words = new WakeWords();
    const outbox = new Outbox({
      turn: "wake",
      here: thread,
      sealed: seal !== undefined,
      userName,
      timeZone,
      threads: async () => await reachableThreads(config.dirs.data, character),
      pictureProblems: async (text) => await pictureProblems([text], workspace, signal),
      pushRefusal: () => pushRefusal(characterDir, { topic: config.app.notifications.push_topic, everyMs: config.app.notifications.push_every.asMillis() }, deps.now?.() ?? Date.now()),
      texts,
    });
    const loop = await runBackgroundLoop(request, {
      ...(heard.recordTranscript === undefined ? {} : { recordTranscript: heard.recordTranscript }),
      ...(deps.newsHeard === undefined ? {} : { newsHeard: deps.newsHeard }),
      ...(deps.interrupted === undefined ? {} : { interrupted: deps.interrupted }),
      name: "Wake",
      callTypes: ["wake", "wake_tool_loop"],
      dispatch: (name, input, toolUseId, tools) => deps.dispatch(name, input, toolUseId, tools, { ...conversation, recordWorkspaceWrite: recorder.track, sendMessage: outbox.send }),
      generate: (call, phase, loopSignal) => deps.generate(call, phase, AbortSignal.any([signal, loopSignal])),
      persist: async (round) => {
        signal.throwIfAborted();
        words.heard(round);
        const message = roundMessage(round, request, deps);
        if (log === undefined) {
          await engine.appendMessage(message);
          return;
        }
        working.push(message);
        await keepWorking(log, message);
      },
      character,
      wrapUpGrace: config.app.triggers.max_wrap_up_rounds,
      maxToolRounds,
      timeLimitMs: wake.limitMs,
      wrapUpMs,
      wrapUpText: (msLeft, rounds) => wakeWrapUpText(texts, msLeft, rounds, userName),
      note: (detail) => note("tool_use", detail),
      news: (wrappingUp) => wakeNewsNote(texts, deps.news?.(wrappingUp) ?? [], userName, timeZone),
    });

    if (signal.aborted) {
      note("call_failed", `Wake in "${thread}" stopped: the thread was changed while it ran`);
      return { events };
    }
    if (loop.failedRound !== undefined) await (log?.engine ?? engine).recoverInterruptedToolLoop(texts.always("tool_cut_off"));
    const kept = log === undefined ? undefined : keptWorkingSummary(texts, working, { id: log.engine.thread, label: log.label }, {
      msg_id: newId(),
      timestamp: (deps.nowIso ?? (() => new Date().toISOString()))(),
    });
    if (kept !== undefined) await engine.appendMessage(kept);
    const ending = stopOf(loop);
    const stopped = ending?.why;
    if (ending !== undefined) {
      if (ending.why !== "failed") {
        note(ending.why === "interrupted" ? "wake" : "timeout", ending.why === "interrupted"
          ? `Wake in "${thread}" stopped for ${userName}'s message`
          : `Wake in "${thread}" ${ending.why === "time" ? `reached its limit of ${spanPhrase(wake.limitMs)}` : "used up its rounds"} and was stopped`);
      }
      const stoppedNote = wakeStoppedNote(texts, ending, userName, wake.limitMs, wake.fired);
      if (stoppedNote !== undefined) {
        const why = roundMessage({ role: "system", blocks: [{ type: "text", text: stoppedNote }] }, request, deps);
        await engine.appendMessage(why);
        if (log !== undefined) await keepWorking(log, { ...why, msg_id: newId() });
      }
    }
    const waiting = stopped === "interrupted" ? [] : outbox.waiting;
    const here = waiting.filter((each) => each.thread === thread);
    const away = waiting.filter((each) => each.thread !== thread);
    noteOutcome(character, loop, here.length === 0 && away.length === 0, note);
    let sent: Message | undefined;
    for (const sending of here) sent = await postMessage(character, request, sending, heard, note, { thread, engine }, pictures) ?? sent;
    afterwards = async () => {
      await postElsewhere(away, { character, from: thread, turn: "wake", engine: async (name) => await deps.engine(character, name) }, request, heard, note, pictures);
    };
    const keptIn = sent === undefined && log !== undefined ? log.engine : engine;
    const newest = replyVersions(keptIn.messages()).filter((version) => !known.has(version)).at(-1);
    if (newest !== undefined) {
      await recorder.settle(keptIn.thread, newest);
      await pruneTurns(workspaceTurns, keptIn.thread, keptIn.messages());
    }

    const endedAt = deps.now?.() ?? Date.now();
    recordWakeEnd(characterDir, thread, record, { startedAt: nowMs, endedAt, limitMs: wake.limitMs, loop, words, sent: sent !== undefined || away.length > 0 });
    if (stopped === "interrupted") return { events, interrupted: true };

    const runner = heard.compaction;
    const settings = config.app.compaction;
    const tier = imageTierForModel((override ?? resolved).modelId);
    if (log !== undefined) {
      const logged = log.engine.messages();
      const keepWakes = Math.max(1, settings.keep_recent_turns);
      if (nearMessageBudget(logged, built.messageBudget, tier) && canArchiveTurns(logged, keepWakes)) {
        await archiveTrimmedTurns(config.dirs.data, log.engine, character, workspace, keepWakes, () => new Date().toISOString(), { applyDeferredEdits: async () => {} });
      }
    }
    if (runner === undefined || thread === home) return { events };
    const active = engine.messages();
    const measured = withoutWakeWorking(texts, active);
    const crowded = nearMessageBudget(measured, built.messageBudget, tier) && canArchiveTurns(active, settings.keep_recent_turns);
    const trim = async (keep: number): Promise<void> => {
      await archiveTrimmedTurns(config.dirs.data, engine, character, workspace, keep, () => new Date().toISOString(), runner);
    };
    if (index?.threads.find((each) => each.id === thread)?.compaction === false) {
      if (crowded) await trim(settings.keep_recent_turns);
      return { events };
    }
    const turns = engine.turnCount();
    const tokens = estimateHistoryTokens(measured, tier);
    const written = Math.max(turns - leadingWakeTurns(active), 1);
    if (written < turns) {
      if (threadShouldCompact(config, turns, tokens, crowded)) await trim(written);
      return { events };
    }
    if (!threadShouldCompact(config, engine.userTurnCount(), tokens, crowded)) return { events };
    await maybeCompact({
      autonomy: {
        shouldCompactNow: () => true,
        onCompactionComplete: () => {},
        onCompactionFailed: () => {},
      },
    }, engine, character, config, config.dirs.data, tokens, runner, crowded);
    return { events };
  });
  await afterwards?.();
  return result;
}
