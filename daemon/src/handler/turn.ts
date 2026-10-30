import { compactLater, type CompactionCompletion } from "../memory/compaction/background.ts";
import { runningPass } from "../memory/compaction/activity.ts";
import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import type { Message } from "../engine/types.ts";
import type { PendingAlt } from "../engine/message_store.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { StreamResult } from "../llm/stream.ts";
import { emitStreamEnd } from "../llm/stream.ts";
import type { Usage } from "../llm/types.ts";
import { compactionHeld } from "../memory/compaction/checkpoint.ts";
import { heartbeatThread, homeThread, homeThreadOf, isHeartbeatOpener, readThreadsIndex } from "../engine/threads.ts";
import { MessageStore } from "../engine/message_store.ts";
import { conversationRef, SegmentReader } from "../engine/segments.ts";
import { readDurable, threadFile } from "../storage/files.ts";
import { archiveKey, characterDataDir, threadDataDir } from "../config/dirs.ts";
import { HISTORY_DB_FILE } from "../engine/history_store.ts";
import { archivalPlanInput, archiveSplitIndex } from "../memory/compaction/plan.ts";
import { conversationManager } from "../memory/compaction/archive.ts";
import { tryBeginCompaction } from "../memory/compaction/manager.ts";
import { join } from "node:path";
import { CompactionPaused } from "../memory/compaction/types.ts";
import type { CharacterWorkspace } from "../tools/character_workspace.ts";
import { emitNewMessageEvent } from "./persistence.ts";
import { ingestImages, type ImageUpload } from "./images.ts";
import { DEFAULT_IMAGE_SETTINGS, type ImageSettings } from "../llm/image_settings.ts";

export interface TurnEngine {
  readonly thread?: string;
  messages(): readonly Message[];
  appendMessage(msg: Message): Promise<void>;
  currentRevision(): number;
  turnCount(): number;
  pendingRegenAlt(): PendingAlt | undefined;
  messagesAfterLastUserTurn(): readonly Message[];
  segments(): { segmentCount(): number; readSegment(index: number): Promise<Message[]> };
  reload(): Promise<void>;
}

export interface TurnAutonomy {
  ensureState(character: string, config: LoadedConfig): boolean;
  needsActivityBackfill(character: string): boolean;
  backfillActivity(character: string, timestamps: readonly Date[]): void;
  onUserMessage(character: string, turnCount: number): void;
  onUserActivityElsewhere?(character: string): void;
  shouldCompactNow(character: string, turnCount: number, contextTokens: number, crowded?: boolean): boolean;
  onCompactionComplete(character: string, retained: number): void;
  onCompactionFailed(character: string, retryAt?: number): void;
}

export interface TurnContext {
  emitEvent: (message: ServerMessage) => void;
  sendDirect: (message: ServerMessage) => void;
  accepted?: () => Promise<void>;
  autonomy: TurnAutonomy;
  now: () => string;
  newMessageId: () => string;
}

export interface TurnBody {
  text: string;
  images: readonly string[];
  image_data: readonly ImageUpload[];
}

export function bodyHasContent(body: TurnBody): boolean {
  return body.text !== "" || body.images.length > 0 || body.image_data.length > 0;
}

export async function appendUserTurn(
  ctx: TurnContext,
  engine: TurnEngine,
  cacheDir: string,
  charName: string,
  body: TurnBody,
  regen: boolean,
  rid: string | null = null,
  uploadSettings: Readonly<ImageSettings> = DEFAULT_IMAGE_SETTINGS,
  annotations: Pick<Message, "last_elsewhere"> = {},
): Promise<PendingAlt | undefined> {
  if (regen) return engine.pendingRegenAlt() ?? { alternatives: [] };
  if (!bodyHasContent(body)) return undefined;

  const { images, blocks } = await ingestImages(
    cacheDir,
    charName,
    body.images,
    body.image_data,
    uploadSettings,
  );

  const contentBlocks = [...blocks];
  if (body.text !== "") contentBlocks.push({ type: "text", text: body.text });

  const userMsg: Message = {
    msg_id: ctx.newMessageId(),
    role: "user",
    content: body.text,
    images,
    content_blocks: contentBlocks,
    alternatives: [],
    timestamp: ctx.now(),
    ...annotations,
  };

  await engine.appendMessage(userMsg);

  emitNewMessageEvent(
    ctx.emitEvent,
    charName,
    "user_input",
    engine.currentRevision(),
    { ...userMsg, images: userMsg.images.map((i) => ({ ...i })) },
    engine.thread,
    rid,
  );
  await ctx.accepted?.();

  return undefined;
}

const ACTIVITY_BACKFILL_DAYS = 90;
const SEGMENTS_PAST_THE_WINDOW = 3;

export async function ensureAndBackfillAutonomy(
  ctx: Pick<TurnContext, "autonomy">,
  engine: TurnEngine,
  charName: string,
  config: LoadedConfig,
  now: Date = new Date(),
): Promise<void> {
  ctx.autonomy.ensureState(charName, config);
  if (!ctx.autonomy.needsActivityBackfill(charName)) return;

  const cutoff = new Date(now.getTime() - ACTIVITY_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const timestamps: Date[] = [];

  const collect = (msgs: readonly Message[]): number => {
    let kept = 0;
    for (const msg of msgs) {
      if (msg.role !== "user" || isToolResultOnly(msg) || isHeartbeatOpener(msg)) continue;
      const at = new Date(msg.timestamp);
      if (Number.isNaN(at.getTime()) || at < cutoff) continue;
      timestamps.push(at);
      kept += 1;
    }
    return kept;
  };

  const collectThread = async (
    messages: readonly Message[],
    segments: { segmentCount(): number; readSegment(index: number): Promise<Message[]> },
  ): Promise<void> => {
    collect(messages);
    let barren = 0;
    for (let i = segments.segmentCount() - 1; i >= 0 && barren < SEGMENTS_PAST_THE_WINDOW; i -= 1) {
      try {
        barren = collect(await segments.readSegment(i)) === 0 ? barren + 1 : 0;
      } catch {
      }
    }
  };

  await collectThread(engine.messages(), engine.segments());
  const dataDir = config.dirs.data;
  const index = await readThreadsIndex(dataDir, charName);
  const current = engine.thread ?? homeThread(index);
  for (const thread of index?.threads ?? []) {
    if (thread.id === current || thread.id === heartbeatThread(index)) continue;
    try {
      const store = await MessageStore.load(threadFile(dataDir, charName, thread.id, "active.jsonl"));
      const segments = await SegmentReader.load(conversationRef(dataDir, charName, thread.id, false));
      try {
        await collectThread(store.messages(), segments);
      } finally {
        segments.close();
      }
    } catch (e) {
      shoreLog.warn(`shore: could not read ${charName}/${thread.id} for activity history: ${String(e)}`);
    }
  }

  ctx.autonomy.backfillActivity(charName, timestamps);
}

function isToolResultOnly(msg: Message): boolean {
  return (
    msg.role === "user" &&
    msg.content_blocks.length > 0 &&
    msg.content_blocks.every((b) => b.type === "tool_result")
  );
}

export function notifyUserMessageIfFresh(
  ctx: TurnContext,
  engine: TurnEngine,
  charName: string,
  body: TurnBody,
  regen: boolean,
): void {
  if (regen || !bodyHasContent(body)) return;
  ctx.autonomy.onUserMessage(charName, engine.turnCount());
}

export function contextTokensFor(usage: Usage): number {
  const sum =
    BigInt(usage.input_tokens) +
    BigInt(usage.cache_read_tokens) +
    BigInt(usage.cache_creation_tokens);
  const ceiling = BigInt("18446744073709551615");
  return Number(sum > ceiling ? ceiling : sum);
}

export function emitPostPersistStreamEnd(
  ctx: TurnContext,
  engine: TurnEngine,
  rid: string | undefined,
  result: StreamResult,
): void {
  const messages = engine.messages();
  const last = messages[messages.length - 1];
  emitStreamEnd(ctx.sendDirect, result, {
    isFinal: true,
    ...(rid === undefined ? {} : { rid }),
    ...(last === undefined ? {} : { msgId: last.msg_id }),
    revision: engine.currentRevision(),
  });
}

export interface CompactionRunner {
  run(charName: string, config: LoadedConfig, thread?: string): Promise<CompactionCompletion>;
  applyDeferredEdits(
    characterDataDir: string,
    workspace: CharacterWorkspace,
    thread?: string,
  ): Promise<void>;
}

type CompactionAutonomy = Pick<TurnAutonomy, "shouldCompactNow" | "onCompactionComplete" | "onCompactionFailed">;

export function threadShouldCompact(config: LoadedConfig, turns: number, tokens: number, crowded: boolean): boolean {
  const c = config.app.memory.compaction;
  return c.enabled && (crowded || (turns >= c.min_turns &&
    ((c.max_turns > 0 && turns >= c.max_turns) ||
     (c.max_context_tokens > 0 && tokens >= c.max_context_tokens))));
}

export async function maybeCompact(
  ctx: { autonomy: CompactionAutonomy },
  engine: Pick<TurnEngine, "thread" | "turnCount">,
  charName: string,
  config: LoadedConfig,
  dataDir: string,
  contextTokens: number,
  runner: CompactionRunner,
  crowded = false,
): Promise<boolean> {
  const turnCount = engine.turnCount();
  const thread = engine.thread ?? await homeThreadOf(dataDir, charName);
  if (await compactionHeld(dataDir, charName, thread)) return false;
  if (runningPass(dataDir, charName)?.thread === thread) return false;
  if (!ctx.autonomy.shouldCompactNow(charName, turnCount, contextTokens, crowded)) return false;
  return compactLater(dataDir, charName, thread, async () => await compactAfterTurn(ctx, charName, config, thread, runner));
}

export async function compactAfterTurn(
  ctx: { autonomy: CompactionAutonomy },
  charName: string,
  config: LoadedConfig,
  thread: string,
  runner: CompactionRunner,
): Promise<void> {
  let completion: CompactionCompletion;
  try {
    completion = await runner.run(charName, config, thread);
  } catch (e) {
    shoreLog.warn(`shore: compaction after a turn failed for ${charName}/${thread}: ${String(e)}`);
    ctx.autonomy.onCompactionFailed(
      charName,
      e instanceof CompactionPaused && e.resumeAt !== undefined
        ? Date.parse(e.resumeAt)
        : undefined,
    );
    return;
  }
  if (completion.kind !== "completed") {
    ctx.autonomy.onCompactionFailed(charName, completion.retryAt);
    return;
  }
  ctx.autonomy.onCompactionComplete(charName, completion.retained);
}

export async function archiveTrimmedTurns(
  dataDir: string,
  engine: { readonly thread: string; reload(): Promise<void> },
  charName: string,
  workspace: CharacterWorkspace,
  keepTurns: number,
  now: () => string,
  runner: Pick<CompactionRunner, "applyDeferredEdits">,
): Promise<void> {
  const guard = tryBeginCompaction(dataDir, charName);
  if (guard === undefined) return;
  try {
    const raw = readDurable(threadFile(dataDir, charName, engine.thread, "active.jsonl"));
    const input = archivalPlanInput(raw);
    const splitAt = archiveSplitIndex([...input.messages], keepTurns, false);
    if (splitAt === 0) return;
    await conversationManager(
      threadDataDir(dataDir, charName, engine.thread),
      { dbPath: join(dataDir, HISTORY_DB_FILE), archiveKey: archiveKey(charName, engine.thread) },
      now,
      () => crypto.randomUUID(),
    ).archiveAndRetain("trim", { keepLastN: input.messages.length - splitAt, activeContent: raw });
  } catch (e) {
    shoreLog.warn(`shore: could not archive the turns ${charName}/${engine.thread} trimmed without compaction: ${String(e)}`);
    return;
  } finally {
    guard.release();
  }
  await engine.reload();
  try {
    await runner.applyDeferredEdits(characterDataDir(dataDir, charName), workspace, engine.thread);
  } catch (e) {
    shoreLog.warn(`shore: could not refresh the prompt files of ${charName}/${engine.thread} after archiving: ${String(e)}`);
  }
}
