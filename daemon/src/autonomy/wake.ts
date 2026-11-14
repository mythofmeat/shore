import wakeTemplateRaw from "../../prompts/autonomy/wake.md" with { type: "text" };

import type { RebuildDeps } from "../cache/rebuild.ts";
import { resolveDisplayName, toolGrants } from "../config/app.ts";
import { characterDataDir, resolvePromptTemplate, threadDataDir } from "../config/dirs.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { applyBackgroundSettings, configView, resolveChatModelForCharacter } from "../config/preferences.ts";
import { pictureText } from "../engine/embeds.ts";
import { withConversation } from "../engine/lifecycle.ts";
import { deriveContentFromBlocks, isToolResultOnly } from "../engine/message_store.ts";
import { agoPhrase, diaryText, DIARY_FOR_WAKE, estimateHistoryTokens, formatWallClock, nearMessageBudget, presenceText, renderTemplate } from "../engine/prompt.ts";
import { sealedThreads, type SealedThread } from "../engine/sealed_list.ts";
import { NO_PRIOR_CONTEXT } from "../engine/segments.ts";
import { homeThread, isWakeOpener, readThreadsIndex, threadActivities, threadActivityNow, type ThreadsIndex } from "../engine/threads.ts";
import type { ContentBlock, Message } from "../engine/types.ts";
import { newMessageVersion } from "../engine/versions.ts";
import { buildChatShapeRequestFromDisk } from "../handler/context.ts";
import { cacheTtlSecs, thinkingEnabled } from "../handler/generation.ts";
import { firstSentPicture, pictureProblems, sendPictures, type PictureSender } from "../handler/pictures.ts";
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
import { addDiaryNote, closingNote, recentDiary } from "./diary.ts";
import type { HeartbeatEventKind } from "./heartbeat_log.ts";
import { runBackgroundLoop, type BackgroundLoopDeps, type BackgroundLoopResult, type LoopRound } from "./background_loop.ts";
import { presence } from "./presence.ts";
import { firedBy, WAKE_QUIET_MS, type TriggerFiring, type WakeNews, type WakeResult } from "./runner.ts";
import { sealedListNote, sealedWakeNote } from "./sealed_notes.ts";
import { digestWords, threadDigest, type ThreadReader } from "./thread_digest.ts";
import { buildAutonomousMessage, sendMessageIn, spanPhrase, timeLeftPhrase, triggerFiredNote, wakeNewsNote } from "./wake_shape.ts";
import { keptNote, recordWakeEnd, stopOf, wakeRecord, wakeStopNote, WakeWords, type WakeStopReason } from "./wake_record.ts";
import { withoutWakeWorking } from "./wake_working.ts";

export const WAKE_OPENER = "[wake]";

const LONGEST_WRAP_UP_MS = 15 * 60_000;

const DEFAULT_WAKE_TEMPLATE = wakeTemplateRaw.trimEnd();

const SENT = /<sendMessage>[\s\S]*?<\/sendMessage>/g;

export interface WakeEngine extends ThreadReader {
  readonly thread: string;
  appendMessage(msg: Message): Promise<void>;
  currentRevision(): number;
  turnCount(): number;
  userTurnCount(): number;
  reload(): Promise<void>;
  recoverInterruptedToolLoop(reason: string): Promise<number>;
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

export interface WakeDeps extends Pick<BackgroundLoopDeps, "recordTranscript" | "newsHeard"> {
  rebuild: RebuildDeps;
  generate: (...args: Parameters<BackgroundLoopDeps["generate"]>) => Promise<GenerateResponse>;
  dispatch: (...args: [...Parameters<BackgroundLoopDeps["dispatch"]>, ToolConversation]) => ReturnType<BackgroundLoopDeps["dispatch"]>;
  engine(character: string, thread: string): Promise<WakeEngine | undefined>;
  threadModel(character: string, thread: string): string | undefined;
  interrupted?: () => boolean;
  sealed?: (character: string, thread: string) => Promise<SealedWake | undefined>;
  news?: (wrappingUp: boolean) => WakeNews[];
  emit?: (character: string, revision: number, msg: Message, thread: string) => void;
  notify?: (title: string, body: string, picture?: NotificationPicture) => void;
  budgetBlockFor?: (request: SidecarRequest) => CallBlock | undefined;
  compaction?: CompactionRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeZone?: string;
  newId?: () => string;
  nowIso?: () => string;
}

type Note = (kind: HeartbeatEventKind, detail: string) => void;

export function wrapUpMsFor(limitMs: number): number {
  return Math.min(LONGEST_WRAP_UP_MS, Math.floor(limitMs / 6));
}

export function wakeWrapUpText(msLeft: number, rounds: number, userName: string): string {
  const stop = rounds === 1 ? "after this round" : `after ${String(rounds)} more rounds, counting this one`;
  return `[System nudge: this wake stops in ${timeLeftPhrase(msLeft)} or ${stop}, whichever comes first. ` +
    "Wrap up now: finish with your note to yourself, saying where you stopped so you can pick it up here next time. " +
    `Only what you put in <sendMessage> tags is sent to ${userName}.]`;
}

export function withoutSent(blocks: readonly ContentBlock[], userName: string): ContentBlock[] {
  return blocks.map((block) => block.type === "text" ? { ...block, text: block.text.replace(SENT, `[sent to ${userName} as the next message here]`) } : block);
}

export function wakeStoppedNote(why: WakeStopReason, userName: string, limitMs: number): string {
  if (why === "interrupted") {
    return `[${userName} wrote here while this wake was running, so Shore stopped it here for you to answer them. ` +
      `Once they have been quiet in this thread for ${spanPhrase(WAKE_QUIET_MS)}, Shore wakes you here again to pick it up.]`;
  }
  return why === "time"
    ? `[This wake reached its limit of ${spanPhrase(limitMs)}, and Shore stopped it here.]`
    : "[This wake used up its rounds of tool use, and Shore stopped it here.]";
}

export function wakeCutShortNote(why: "time" | "rounds", thread: string, limitMs: number): string {
  const ran = why === "time" ? `reached its limit of ${spanPhrase(limitMs)}` : "used up its rounds of tool use";
  return `Your wake in "${thread}" ${ran} before you finished. Where it stopped is in that thread.`;
}

export function leadingWakeTurns(messages: readonly Message[]): number {
  const turns = messages.filter((message) => message.role === "user" && !isToolResultOnly(message));
  const written = turns.findIndex((message) => !isWakeOpener(message));
  return written === -1 ? turns.length : written;
}

export async function lastWroteNote(
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
  for (const thread of index.threads) {
    const at = Date.parse(activity.get(thread.id)?.last_user ?? "");
    if (Number.isNaN(at) || (latest !== undefined && at <= latest.at)) continue;
    latest = { id: thread.id, label: thread.label, at };
  }
  if (latest === undefined) return undefined;
  const ago = agoPhrase((nowMs - latest.at) / 1000);
  if (latest.id === here) return `[${userName} last wrote to you ${ago}, in this thread.]`;
  if (latest.id === home) return `[${userName} last wrote to you ${ago}, in your home thread "${home}".]`;
  const name = latest.label === undefined ? `"${latest.id}"` : `"${latest.id}" (${latest.label})`;
  return `[${userName} last wrote to you ${ago}, in the side thread ${name}, which isn't shown here.]`;
}

function shortPreview(text: string): string {
  return Array.from(text).slice(0, 80).join("");
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

export interface WakePost {
  thread: string;
  engine: Pick<WakeEngine, "appendMessage" | "currentRevision">;
}

export async function postWakeMessage(
  character: string,
  request: SidecarRequest,
  loop: BackgroundLoopResult,
  deps: Pick<WakeDeps, "emit" | "notify" | "newId" | "nowIso">,
  note: Note,
  to: WakePost,
  pictures: PictureSender,
): Promise<Message | undefined> {
  const nothing = loop.sendMessageText === undefined && loop.images.length === 0;
  if (loop.failedRound !== undefined && loop.timedOut !== true) noteFailure(character, loop.failedRound, loop.failure, note);
  else if (nothing && loop.failedRound === undefined) note("message_skipped", "Wake completed — no message sent");
  if (nothing) return undefined;

  const text = loop.sendMessageText ?? "";
  const shape = buildAutonomousMessage(text, loop.images, request.provider_key, request.model === "" ? undefined : request.model);
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
  msg.images.push(...await sendPictures([text], pictures));

  let persisted: Message | undefined;
  try {
    await to.engine.appendMessage(msg);
    persisted = msg;
    deps.emit?.(character, to.engine.currentRevision(), msg, to.thread);
  } catch (e) {
    shoreLog.error(`shore: a wake could not deliver its message for ${character} to ${to.thread}: ${String(e)}`);
  }

  const shown = pictureText(msg.content, msg.images);
  deps.notify?.(`Shore - ${character}`, shown, firstSentPicture(msg.images));
  note("message_sent", `Autonomous message sent: ${shortPreview(shown)}`);
  return persisted;
}

export async function roundMessage(round: LoopRound, request: SidecarRequest, deps: Pick<WakeDeps, "newId" | "nowIso">, pictures: PictureSender): Promise<Message> {
  const model = round.model === undefined || round.model === "" ? request.model : round.model;
  const sent = round.role === "assistant" ? sendMessageIn(round.blocks) : undefined;
  return {
    msg_id: (deps.newId ?? (() => `m_${crypto.randomUUID()}`))(),
    role: round.role,
    content: deriveContentFromBlocks(round.blocks, true),
    images: sent === undefined ? [] : await sendPictures([sent], pictures),
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

export async function runWake(character: string, config: LoadedConfig, wake: Wake, deps: WakeDeps): Promise<WakeResult> {
  const events: { kind: HeartbeatEventKind; detail: string }[] = [];
  const characterDir = characterDataDir(config.dirs.data, character);
  const engine = await deps.engine(character, wake.thread);
  if (engine === undefined) {
    addDiaryNote(characterDir, { at: deps.now?.() ?? Date.now(), thread: "", source: "shore", text: `You were to be woken in the thread "${wake.thread}" by ${firedBy(wake.fired)}, but you have no such thread, so nothing ran. \`list_threads\` shows the threads you do have.` });
    events.push({ kind: "call_failed", detail: `Wake skipped: no thread "${wake.thread}"` });
    return { events };
  }
  const seal = await deps.sealed?.(character, wake.thread);
  const thread = engine.thread;
  const { recordTranscript: _recorded, emit: _emitted, notify: _announced, compaction: _compacted, ...unheard } = deps;
  const heard: WakeDeps = seal === undefined ? deps : unheard;
  const note: Note = (kind, detail) => {
    if (seal === undefined) events.push({ kind, detail });
    else if (kind !== "tool_use") events.push({ kind, detail: kind === "message_sent" ? "A message was left in a sealed thread" : detail });
  };

  return await withConversation(threadDataDir(config.dirs.data, character, thread), "turn", async (signal) => {
    const index = await readThreadsIndex(config.dirs.data, character);
    const home = homeThread(index);
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
    const resolved = applyBackgroundSettings(config.dirs.data, character, "wake", chat);
    const configured = backgroundTaskModel(config, character, "wake");
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
    const rendered = renderTemplate(resolvePromptTemplate(config.dirs.config, character, "wake.md") ?? DEFAULT_WAKE_TEMPLATE, new Map([
      ["now", formatWallClock(nowMs, timeZone)],
      ["user", userName],
      ["thread", thread],
      ["home", home],
      ["time_limit", spanPhrase(wake.limitMs)],
      ["wrap_up_after", spanPhrase(wake.limitMs - wrapUpMs)],
      ["max_rounds", maxToolRounds === undefined ? "" : String(maxToolRounds)],
      ["resume_after", spanPhrase(WAKE_QUIET_MS)],
    ]));
    const record = wakeRecord(characterDir, thread);
    const recent = recentDiary(characterDir, nowMs);
    const status = presence(config.dirs.data);
    const fired = wake.fired.map((firing) => triggerFiredNote(firing, timeZone));
    const setOffBy = [...new Set(wake.fired.map((firing) => firing.name).filter((name) => name !== ""))].join(", ");
    const setOff = [...fired, ...(seal === undefined ? [] : [sealedWakeNote(seal.sealed, seal.filesDir, userName, timeZone)]), rendered];
    const id = (deps.newId ?? (() => `m_${crypto.randomUUID()}`))();
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
      WAKE_OPENER,
      await threadDigest(engine, digestWords("this thread"), record.through, userName, timeZone),
      record.stopped === undefined ? undefined : wakeStopNote(record.stopped, userName, timeZone),
      await lastWroteNote(config.dirs.data, character, index, thread, userName, nowMs).catch(() => undefined),
      status === undefined || status.status === "" ? undefined : presenceText(status, nowMs, `${userName}'s`),
      seal === undefined ? sealedListNote(sealedThreads(characterDir), timeZone) : undefined,
      keptNote(record, recent.notes, timeZone),
      recent.notes.length === 0 ? undefined : diaryText(recent.notes, DIARY_FOR_WAKE, timeZone, recent.omitted),
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
    const { request, override } = backgroundModelRequest(built.request, config, character, deps.env, configured, "wake");
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

    await engine.appendMessage({ ...opener([WAKE_OPENER, ...setOff].join("\n\n")), shown_later: [WAKE_OPENER, ...fired].join("\n\n") });
    const conversation = { thread, conversation: [shown] };
    const pictures: PictureSender = { workspace, dir: sentPicturesDir(config.dirs.data, character) };
    const workspaceTurns = workspaceTurnsFor(config.dirs, character, workspace);
    const recorder = new WorkspaceRecorder(workspaceTurns);
    const known = new Set(replyVersions(engine.messages()));
    const words = new WakeWords();
    const loop = await runBackgroundLoop(request, {
      ...(heard.recordTranscript === undefined ? {} : { recordTranscript: heard.recordTranscript }),
      ...(deps.newsHeard === undefined ? {} : { newsHeard: deps.newsHeard }),
      ...(deps.interrupted === undefined ? {} : { interrupted: deps.interrupted }),
      name: "Wake",
      callTypes: ["wake", "wake_tool_loop"],
      dispatch: (name, input, toolUseId, tools) => deps.dispatch(name, input, toolUseId, tools, { ...conversation, recordWorkspaceWrite: recorder.track }),
      generate: (call, phase, loopSignal) => deps.generate(call, phase, AbortSignal.any([signal, loopSignal])),
      persist: async (round) => {
        words.heard(round);
        const last = round.role === "assistant" && !round.blocks.some((block) => block.type === "tool_use");
        await engine.appendMessage(await roundMessage(last ? { ...round, blocks: withoutSent(round.blocks, userName) } : round, request, deps, pictures));
      },
      character,
      wrapUpGrace: config.app.triggers.max_wrap_up_rounds,
      maxToolRounds,
      timeLimitMs: wake.limitMs,
      wrapUpMs,
      wrapUpText: (msLeft, rounds) => wakeWrapUpText(msLeft, rounds, userName),
      note: (detail) => note("tool_use", detail),
      news: (wrappingUp) => wakeNewsNote(deps.news?.(wrappingUp) ?? [], userName, timeZone),
      checkPictures: async (sent) => await pictureProblems([sent], workspace, signal),
    });

    if (signal.aborted) {
      note("call_failed", `Wake in "${thread}" stopped: the thread was changed while it ran`);
      return { events };
    }
    if (loop.failedRound !== undefined) await engine.recoverInterruptedToolLoop("The wake ended before this tool returned a result.");
    const stopped = stopOf(loop);
    if (stopped !== undefined) {
      note(stopped === "interrupted" ? "wake" : "timeout", stopped === "interrupted"
        ? `Wake in "${thread}" stopped for ${userName}'s message`
        : `Wake in "${thread}" ${stopped === "time" ? `reached its limit of ${spanPhrase(wake.limitMs)}` : "used up its rounds"} and was stopped`);
      await engine.appendMessage(await roundMessage({ role: "system", blocks: [{ type: "text", text: wakeStoppedNote(stopped, userName, wake.limitMs) }] }, request, deps, pictures));
    }
    const sent = await postWakeMessage(character, request, loop, heard, note, { thread, engine }, pictures);
    const newest = replyVersions(engine.messages()).filter((version) => !known.has(version)).at(-1);
    if (newest !== undefined) {
      await recorder.settle(thread, newest);
      await pruneTurns(workspaceTurns, thread, engine.messages());
    }

    const endedAt = deps.now?.() ?? Date.now();
    const noted = closingNote(words.closing);
    const left = noted === undefined ? undefined : addDiaryNote(characterDir, { at: endedAt, thread, source: "wake", text: noted });
    recordWakeEnd(characterDir, thread, record, { startedAt: nowMs, endedAt, limitMs: wake.limitMs, loop, words, sent: sent !== undefined, note: left });
    if (stopped === "interrupted") return { events, interrupted: true };
    if (stopped !== undefined) addDiaryNote(characterDir, { at: endedAt, thread: "", source: "shore", text: wakeCutShortNote(stopped, thread, wake.limitMs) });

    const runner = heard.compaction;
    if (runner === undefined || thread === home) return { events };
    const active = engine.messages();
    const measured = withoutWakeWorking(active);
    const settings = config.app.compaction;
    const tier = imageTierForModel((override ?? resolved).modelId);
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
}
