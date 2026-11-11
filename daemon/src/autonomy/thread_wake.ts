import wakeTemplateRaw from "../../prompts/autonomy/wake.md" with { type: "text" };

import { resolveDisplayName, toolGrants } from "../config/app.ts";
import { characterDataDir, resolvePromptTemplate, threadDataDir } from "../config/dirs.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { configView, resolveActiveModelAndOverlay } from "../config/preferences.ts";
import { withConversation } from "../engine/lifecycle.ts";
import { formatWallClock, renderTemplate } from "../engine/prompt.ts";
import { homeThreadOf } from "../engine/threads.ts";
import type { SealedThread } from "../engine/sealed_list.ts";
import type { ContentBlock, Message } from "../engine/types.ts";
import { buildChatShapeRequestFromDisk } from "../handler/context.ts";
import { thinkingEnabled } from "../handler/generation.ts";
import { pictureProblems, type PictureSender } from "../handler/pictures.ts";
import { resolveGenerationModel } from "../handler/setup.ts";
import { contextTokensFor, maybeCompact, threadShouldCompact } from "../handler/turn.ts";
import { usageConfigView } from "../ledger/budget.ts";
import { budgetBlockFor } from "../ledger/gate.ts";
import { hostZone } from "../ledger/zoned.ts";
import { shoreLog } from "../log.ts";
import { sentPicturesDir } from "../storage/sent_pictures.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import { replyVersions, WorkspaceRecorder, workspaceTurnsFor } from "../tools/workspace_turns.ts";
import { addDiaryNote, closingNote, unseenDiary } from "./diary.ts";
import type { HeartbeatEventKind } from "./heartbeat_log.ts";
import { HEARTBEAT_TIME_LIMIT_MS, runHeartbeatToolLoop } from "./heartbeat_loop.ts";
import { heartbeatNewsNote, spanPhrase, timeLeftPhrase, triggerFiredNote } from "./heartbeat_shape.ts";
import { persistHeartbeatMessage, roundMessage, type HeartbeatEngine, type HeartbeatTickDeps } from "./heartbeat_tick.ts";
import { presence, unshownPresence } from "./presence.ts";
import { sealedWakeNote } from "./sealed_notes.ts";
import { firedBy, WAKE_QUIET_MS, type ThreadWakeResult, type TriggerFiring } from "./runner.ts";

export const WAKE_OPENER = "[wake]";

export const DEFAULT_WAKE_LIMIT_MS = HEARTBEAT_TIME_LIMIT_MS;

const LONGEST_WRAP_UP_MS = 15 * 60_000;

const DEFAULT_WAKE_TEMPLATE = wakeTemplateRaw.trimEnd();

const SENT = /<sendMessage>[\s\S]*?<\/sendMessage>/g;

export interface ThreadWake {
  thread: string;
  fired: readonly TriggerFiring[];
  limitMs: number;
  interruptedAt?: number | undefined;
}

export interface SealedWake {
  sealed: SealedThread;
  filesDir: string;
}

export interface ThreadWakeDeps extends Omit<HeartbeatTickDeps, "threads" | "wakeReason" | "fired" | "cutOff"> {
  engine(character: string, thread: string): Promise<HeartbeatEngine | undefined>;
  threadModel(character: string, thread: string): string | undefined;
  interrupted?: () => boolean;
  sealed?: (character: string, thread: string) => Promise<SealedWake | undefined>;
}

export function wrapUpMsFor(limitMs: number): number {
  return Math.min(LONGEST_WRAP_UP_MS, Math.floor(limitMs / 6));
}

export function wakeWrapUpText(msLeft: number, rounds: number, userName: string): string {
  const stop = rounds === 1 ? "after this round" : `after ${String(rounds)} more rounds, counting this one`;
  return `[System nudge: this wake stops in ${timeLeftPhrase(msLeft)} or ${stop}, whichever comes first. ` +
    "Wrap up now: finish with your note to yourself, saying where you stopped so you can pick it up here next time. " +
    `Only what you put in <sendMessage> tags is posted for ${userName}.]`;
}

export function withoutSent(blocks: readonly ContentBlock[], userName: string): ContentBlock[] {
  return blocks.map((block) => block.type === "text" ? { ...block, text: block.text.replace(SENT, `[sent to ${userName} as the next message here]`) } : block);
}

export type WakeStop = "interrupted" | "time" | "rounds";

export function wakeStoppedNote(why: WakeStop, userName: string, limitMs: number): string {
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

export function pickedUpNote(interruptedAt: number, userName: string, timeZone: string): string {
  return `[This picks up the wake that ${userName} interrupted at ${formatWallClock(interruptedAt, timeZone)}.]`;
}

export async function runThreadWake(
  character: string,
  config: LoadedConfig,
  wake: ThreadWake,
  deps: ThreadWakeDeps,
): Promise<ThreadWakeResult> {
  const { thread } = wake;
  const seal = await deps.sealed?.(character, thread);
  const { recordTranscript: _recorded, emit: _emitted, notify: _announced, compaction: _compacted, ...unheard } = deps;
  const heard: ThreadWakeDeps = seal === undefined ? deps : unheard;
  const events: { kind: HeartbeatEventKind; detail: string }[] = [];
  const note = (kind: HeartbeatEventKind, detail: string): void => {
    if (seal === undefined) events.push({ kind, detail });
    else if (kind !== "tool_use") events.push({ kind, detail: kind === "message_sent" ? "A message was left in a sealed thread" : detail });
  };
  const characterDir = characterDataDir(config.dirs.data, character);
  const engine = await deps.engine(character, thread);
  if (engine === undefined) {
    addDiaryNote(characterDir, { at: deps.now?.() ?? Date.now(), thread: "", source: "shore", text: `You were to be woken in the thread "${thread}" by ${firedBy(wake.fired)}, but you have no such thread, so nothing ran. \`list_threads\` shows the threads you do have.` });
    note("call_failed", `Wake skipped: no thread "${thread}"`);
    return { events };
  }

  return await withConversation(threadDataDir(config.dirs.data, character, thread), "turn", async (signal) => {
    const { model, overlay } = resolveActiveModelAndOverlay(
      configView(config),
      character,
      (view, cacheDir, name, includeHidden) => findEffectiveModel(view, cacheDir, name, includeHidden),
      deps.threadModel(character, thread),
    );
    const resolved = resolveGenerationModel(model, config, overlay);
    const nowMs = deps.now?.() ?? Date.now();
    const timeZone = deps.timeZone ?? hostZone();
    const userName = resolveDisplayName(config.app.defaults, deps.env);
    const wrapUpMs = wrapUpMsFor(wake.limitMs);
    const rendered = renderTemplate(resolvePromptTemplate(config.dirs.config, character, "wake.md") ?? DEFAULT_WAKE_TEMPLATE, new Map([
      ["now", formatWallClock(nowMs, timeZone)],
      ["user", userName],
      ["thread", thread],
      ["time_limit", spanPhrase(wake.limitMs)],
      ["wrap_up_after", spanPhrase(wake.limitMs - wrapUpMs)],
      ["max_rounds", resolved.maxToolIterations === undefined ? "" : String(resolved.maxToolIterations)],
      ["resume_after", spanPhrase(WAKE_QUIET_MS)],
    ]));
    const text = [
      WAKE_OPENER,
      ...(wake.interruptedAt === undefined ? [] : [pickedUpNote(wake.interruptedAt, userName, timeZone)]),
      ...wake.fired.map((firing) => triggerFiredNote(firing, timeZone)),
      ...(seal === undefined ? [] : [sealedWakeNote(seal.sealed, seal.filesDir, userName, timeZone)]),
      rendered,
    ].join("\n\n");
    const diary = unseenDiary(characterDir, engine.messages(), nowMs, thread);
    const status = unshownPresence(presence(config.dirs.data), engine.messages());
    const opener: Message = {
      msg_id: (deps.newId ?? (() => `m_${crypto.randomUUID()}`))(),
      role: "user",
      origin: "autonomous",
      content: text,
      images: [],
      content_blocks: [{ type: "text", text }],
      alternatives: [],
      timestamp: new Date(nowMs).toISOString(),
      ...(diary.length === 0 ? {} : { diary }),
      ...(status === undefined ? {} : { presence: status }),
    };

    let built: Awaited<ReturnType<typeof buildChatShapeRequestFromDisk>>;
    try {
      built = await buildChatShapeRequestFromDisk(character, characterDir, config, resolved, [...engine.messages(), opener], engine.segments().segmentCount() > 0, {
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
    const request = built.request;
    request.context = {
      ...request.context,
      ledger: `${config.dirs.data}/shore.db`,
      usage: usageConfigView(config.app.usage),
      character,
      thread,
      call_type: "heartbeat",
      thinking_enabled: thinkingEnabled(request.provider_options),
      ...(seal === undefined ? {} : { sealed: true }),
    };
    const blocked = (deps.budgetBlockFor ?? budgetBlockFor)(request);
    if (blocked !== undefined) {
      note("budget_paused", `Wake paused before round 0 — ${blocked.summary}`);
      return { events };
    }

    await engine.appendMessage(opener);
    const conversation = { thread, conversation: [...engine.messages()] };
    const workspace = characterWorkspace(config, character);
    const pictures: PictureSender = { workspace, dir: sentPicturesDir(config.dirs.data, character) };
    const workspaceTurns = workspaceTurnsFor(config.dirs, character, workspace);
    const recorder = new WorkspaceRecorder(workspaceTurns);
    const known = new Set(replyVersions(engine.messages()));
    let closing = "";
    const loop = await runHeartbeatToolLoop(request, {
      ...heard,
      name: "Wake",
      dispatch: (name, input, toolUseId, tools) => deps.dispatch(name, input, toolUseId, tools, { ...conversation, recordWorkspaceWrite: recorder.track }),
      generate: (call, phase, loopSignal) => deps.generate(call, phase, AbortSignal.any([signal, loopSignal])),
      persist: async (round) => {
        const last = round.role === "assistant" && !round.blocks.some((block) => block.type === "tool_use");
        if (last) closing = round.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
        await engine.appendMessage(await roundMessage(last ? { ...round, blocks: withoutSent(round.blocks, userName) } : round, request, deps, pictures));
      },
      character,
      wrapUpGrace: config.app.behavior.autonomy.heartbeat.wrap_up_grace_rounds,
      maxToolIterations: resolved.maxToolIterations,
      timeLimitMs: wake.limitMs,
      wrapUpMs,
      wrapUpText: (msLeft, rounds) => wakeWrapUpText(msLeft, rounds, userName),
      note: (detail) => note("tool_use", detail),
      news: () => heartbeatNewsNote(deps.news?.() ?? [], userName, timeZone, "wake"),
      checkPictures: async (sent) => await pictureProblems([sent], workspace, signal),
    });

    if (signal.aborted) {
      note("call_failed", `Wake in "${thread}" stopped: the thread was changed while it ran`);
      return { events };
    }
    const stopped: WakeStop | undefined = loop.timedOut === true ? "time" : loop.stoppedAt;
    if (stopped !== undefined) {
      note(stopped === "interrupted" ? "wake" : "timeout", stopped === "interrupted"
        ? `Wake in "${thread}" stopped for ${userName}'s message`
        : `Wake in "${thread}" ${stopped === "time" ? `reached its limit of ${spanPhrase(wake.limitMs)}` : "used up its rounds"} and was stopped`);
      await engine.appendMessage(await roundMessage({ role: "system", blocks: [{ type: "text", text: wakeStoppedNote(stopped, userName, wake.limitMs) }] }, request, deps, pictures));
    }
    await persistHeartbeatMessage(character, request, loop.timedOut === true ? { ...loop, failedRound: undefined } : loop, heard, note, { thread, engine }, pictures);
    const newest = replyVersions(engine.messages()).filter((version) => !known.has(version)).at(-1);
    if (newest !== undefined) await recorder.settle(thread, newest);

    const endedAt = deps.now?.() ?? Date.now();
    const noted = closingNote(closing);
    if (noted !== undefined) addDiaryNote(characterDir, { at: endedAt, thread, source: "wake", text: noted });
    if (stopped === "interrupted") return { events, interrupted: true };
    if (stopped !== undefined) addDiaryNote(characterDir, { at: endedAt, thread: "", source: "shore", text: wakeCutShortNote(stopped, thread, wake.limitMs) });

    const runner = heard.compaction;
    if (runner !== undefined && loop.usage !== undefined && thread !== await homeThreadOf(config.dirs.data, character)) {
      await maybeCompact({
        autonomy: {
          shouldCompactNow: (_character, turns, tokens) => threadShouldCompact(config, turns, tokens, false),
          onCompactionComplete: () => {},
          onCompactionFailed: () => {},
        },
      }, engine, character, config, config.dirs.data, contextTokensFor(loop.usage), runner);
    }
    return { events };
  });
}
