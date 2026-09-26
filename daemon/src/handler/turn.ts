import type { CompactionCompletion } from "../memory/compaction/background.ts";
import { shoreLog } from "../log.ts";

import type { LoadedConfig } from "../config/loader.ts";
import { characterDataDir } from "../config/dirs.ts";
import type { Message } from "../engine/types.ts";
import type { PendingAlt } from "../engine/message_store.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { StreamResult } from "../llm/stream.ts";
import { emitStreamEnd } from "../llm/stream.ts";
import type { Usage } from "../llm/types.ts";
import { beginCompaction } from "../memory/compaction/manager.ts";
import { CompactionPaused } from "../memory/compaction/types.ts";
import { emitNewMessageEvent } from "./persistence.ts";
import { ingestImages, type ImageUpload } from "./images.ts";

export interface TurnEngine {
  readonly thread?: string;
  messages(): readonly Message[];
  appendMessage(msg: Message): Promise<void>;
  currentRevision(): number;
  turnCount(): number;
  pendingRegenAlt(): PendingAlt | undefined;
  segments(): { segmentCount(): number; readSegment(index: number): Promise<Message[]> };
  reload(): Promise<void>;
}

export interface TurnAutonomy {
  ensureState(character: string, config: LoadedConfig): boolean;
  needsActivityBackfill(character: string): boolean;
  backfillActivity(character: string, timestamps: readonly Date[]): void;
  onUserMessage(character: string, turnCount: number): void;
  shouldCompactNow(character: string, turnCount: number, contextTokens: number): boolean;
  onCompactionComplete(character: string, retained: number): void;
  onCompactionFailed(character: string, retryAt?: number): void;
}

export interface TurnContext {
  emitEvent: (message: ServerMessage) => void;
  sendDirect: (message: ServerMessage) => void;
  autonomy: TurnAutonomy;
  now: () => string;
  newMessageId: () => string;
}

export interface TurnBody {
  text: string;
  images: readonly string[];
  image_data: readonly ImageUpload[];
}

function bodyHasContent(body: TurnBody): boolean {
  return body.text !== "" || body.images.length > 0 || body.image_data.length > 0;
}

export async function appendUserTurn(
  ctx: TurnContext,
  engine: TurnEngine,
  dataDir: string,
  charName: string,
  body: TurnBody,
  regen: boolean,
  rid: string | null = null,
): Promise<PendingAlt | undefined> {
  if (regen) return engine.pendingRegenAlt() ?? { alternatives: [] };
  if (!bodyHasContent(body)) return undefined;

  const { images, blocks } = await ingestImages(
    dataDir,
    charName,
    body.images,
    body.image_data,
    new Date(ctx.now()),
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
      if (msg.role !== "user" || isToolResultOnly(msg)) continue;
      const at = new Date(msg.timestamp);
      if (Number.isNaN(at.getTime()) || at < cutoff) continue;
      timestamps.push(at);
      kept += 1;
    }
    return kept;
  };

  collect(engine.messages());
  const segments = engine.segments();
  let barren = 0;
  for (let i = segments.segmentCount() - 1; i >= 0 && barren < SEGMENTS_PAST_THE_WINDOW; i -= 1) {
    try {
      barren = collect(await segments.readSegment(i)) === 0 ? barren + 1 : 0;
    } catch {
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
    configDir: string,
    charName: string,
    workspaceRoot?: string,
    thread?: string,
  ): Promise<void>;
  repoint?(charName: string, config: LoadedConfig, thread?: string): Promise<void>;
}

export async function maybeCompact(
  ctx: TurnContext,
  engine: TurnEngine,
  charName: string,
  config: LoadedConfig,
  dataDir: string,
  result: StreamResult,
  rid: string | undefined,
  runner: CompactionRunner,
): Promise<boolean> {
  const turnCount = engine.turnCount();
  const contextTokens = contextTokensFor(result.context_usage ?? result.usage);
  if (!ctx.autonomy.shouldCompactNow(charName, turnCount, contextTokens)) return false;

  await runInlineCompaction(ctx, engine, charName, config, dataDir, rid, runner);
  return true;
}

async function runInlineCompaction(
  ctx: TurnContext,
  engine: TurnEngine,
  charName: string,
  config: LoadedConfig,
  dataDir: string,
  rid: string | undefined,
  runner: CompactionRunner,
): Promise<void> {
  ctx.sendDirect({
    type: "phase",
    rid: rid ?? null,
    phase: "compacting",
    model: null,
  });

  let completion: CompactionCompletion;
  try {
    completion = await runner.run(charName, config, engine.thread);
  } catch (e) {
    shoreLog.warn(`shore: inline compaction failed for ${charName}: ${String(e)}`);
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

  const guard = await beginCompaction(dataDir, charName);
  try {
    try {
      await engine.reload();
    } catch (e) {
      shoreLog.warn(`shore: inline compaction engine reload failed for ${charName}: ${String(e)}`);
      ctx.autonomy.onCompactionFailed(charName);
      return;
    }

    try {
      await runner.applyDeferredEdits(
        characterDataDir(dataDir, charName),
        config.dirs.config,
        charName,
        config.dirs.workspace,
        engine.thread,
      );
    } catch (e) {
      shoreLog.warn(`shore: failed to apply deferred edits after compaction: ${String(e)}`);
    }
    try {
      await runner.repoint?.(charName, config, engine.thread);
    } catch (e) {
      shoreLog.warn(`shore: failed to repoint cached request after compaction: ${String(e)}`);
    }
  } finally {
    guard.release();
  }

  ctx.autonomy.onCompactionComplete(charName, completion.retained);
}
