/**
 * The turn driver: what happens between a client frame arriving and the
 * conversation being one turn longer.
 *
 * Ported from `crates/daemon/src/handler/task.rs` — `setup_generation`,
 * `append_user_turn`, `ensure_and_backfill_autonomy`,
 * `emit_post_persist_stream_end`, `maybe_schedule_compaction` and
 * `run_inline_compaction` — pinned by `tests/handler_fixtures/turn_parity.json`.
 *
 * The other half of `task.rs` — resolving the model and assembling the request —
 * is already in `setup.ts`, and the wire builder is in `wire_messages.ts`. This
 * is what is left: the ordering.
 *
 * # This owns `active.jsonl` now
 *
 * {@link appendUserTurn} is the write that made the daemon the owner of
 * conversation state, and porting it is what retires `POST /v1/keepalive/prefix`
 * — the last bridge #12 listed as still standing. The Rust pushed the ping body
 * up because it assembled that body from content blocks it had persisted itself.
 * The same side persists and pings now, so there is nothing to push.
 *
 * # Not wired yet
 *
 * Nothing here reaches a socket. Frames go to the two sinks on
 * {@link TurnContext}, which is what `SessionRouter` will supply when
 * `swp_server` is wired (#18, step 5) — the same arrangement `command_dispatch.ts`
 * already uses, and the reason every branch below replays against a fixture
 * without a client attached.
 *
 * # What was dropped
 *
 * `run_generation_stream`'s fork. The Rust asked `can_delegate_tool_loop`
 * whether the sidecar could drive the whole turn and, if so, handed it over
 * wholesale; otherwise it streamed here and ran the tool phase itself. Both
 * branches are this process now, so the question has one answer and the fork is
 * gone. What survives is the part that was never about the hop: after a stream
 * that stopped on `tool_use`, run the tool phase — and only when tools are
 * actually enabled.
 */

import type { LoadedConfig } from "../config/loader.ts";
import { characterDataDir } from "../config/dirs.ts";
import type { Message } from "../engine/types.ts";
import type { PendingAlt } from "../engine/message_store.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { StreamResult } from "../llm/stream.ts";
import { emitStreamEnd } from "../llm/stream.ts";
import type { Usage } from "../llm/types.ts";
import { emitNewMessageEvent } from "./persistence.ts";
import { ingestImages, type ImageUpload } from "./images.ts";

/** The conversation surface the driver reads and writes. */
export interface TurnEngine {
  messages(): readonly Message[];
  appendMessage(msg: Message): Promise<void>;
  currentRevision(): number;
  turnCount(): number;
  pendingRegenAlt(): PendingAlt | undefined;
  segments(): { segmentCount(): number; readSegment(index: number): Promise<Message[]> };
  reload(): Promise<void>;
}

/** The autonomy surface the driver drives. */
export interface TurnAutonomy {
  /** Create the per-character state if absent. `true` when this call created
   *  it, which is the one moment the activity tracker can be seeded. */
  ensureState(character: string, config: LoadedConfig): boolean;
  backfillActivity(character: string, timestamps: readonly Date[]): void;
  onUserMessage(character: string, turnCount: number): void;
  shouldCompactNow(character: string, turnCount: number, contextTokens: number): boolean;
  onCompactionComplete(character: string, retained: number): void;
  onCompactionFailed(character: string): void;
}

/** The slice of the daemon's `GenContext` this phase uses. */
export interface TurnContext {
  /** Broadcast fan-out — every session sees these. */
  emitEvent: (message: ServerMessage) => void;
  /** The requesting session's channel. Must not throw and may drop. */
  sendDirect: (message: ServerMessage) => void;
  autonomy: TurnAutonomy;
  /** Wall clock, RFC 3339 with offset. Injected so a replay can pin it. */
  now: () => string;
  /** `format!("m_{}", Uuid::new_v4())` in the Rust. */
  newMessageId: () => string;
}

/** The client's message, as the driver reads it. */
export interface TurnBody {
  text: string;
  images: readonly string[];
  image_data: readonly ImageUpload[];
}

/** Whether a body carries anything worth recording. */
export function bodyHasContent(body: TurnBody): boolean {
  return body.text !== "" || body.images.length > 0 || body.image_data.length > 0;
}

/**
 * Record the incoming user turn, or capture the alternatives a regen is about
 * to replace.
 *
 * Returns the regen alternatives to thread into persistence, and `undefined` on
 * a fresh turn.
 *
 * A regen returns early and appends nothing — *including* when its body carries
 * text. The user turn a regen would append is already in the conversation; the
 * body is only there because the client reuses one frame shape for both. The
 * fallback when there is no prior assistant turn is an empty alternatives list
 * rather than `undefined`, because persistence tells the two apart: one means
 * "regenerating, nothing to keep", the other means "not a regen".
 */
export async function appendUserTurn(
  ctx: TurnContext,
  engine: TurnEngine,
  dataDir: string,
  charName: string,
  body: TurnBody,
  regen: boolean,
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

  // Only append a text block when there *is* text. An image-only message must
  // not carry an empty one: it persists into history and later breaks Anthropic
  // requests when a prompt-cache breakpoint lands on it — "cache_control cannot
  // be set for empty text blocks" — which fails the whole request, not the
  // block.
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

  // The stored turn has no origin; the wire copy does. `user_input` is what
  // lets a client tell its own echo from a message that arrived some other way,
  // and the inlined image bytes are what let a client on another machine render
  // it. The copy handed over is a fresh one, so inlining cannot reach back into
  // what the engine just persisted.
  emitNewMessageEvent(
    ctx.emitEvent,
    charName,
    "user_input",
    engine.currentRevision(),
    { ...userMsg, images: userMsg.images.map((i) => ({ ...i })) },
  );

  return undefined;
}

/** How far back a fresh activity tracker looks. */
export const ACTIVITY_BACKFILL_DAYS = 90;

/**
 * Seed a newly created activity tracker from the conversation already on disk.
 *
 * Only on creation. Re-running this every turn would double-count, and the
 * tracker's whole job is to say how often the user is actually around.
 *
 * Archived segments are read as well as the live window. A character with
 * history keeps almost all of it in segments, so seeding from the tail alone
 * would report a quiet user and let the heartbeat treat a busy conversation as
 * dormant.
 *
 * Three kinds of message are skipped: assistant turns, user turns carrying
 * nothing but `tool_result` blocks — a long tool loop is not a busy user — and
 * anything whose timestamp does not parse, so a hand-edited history does not
 * abort the seed for the turns around it.
 */
export async function ensureAndBackfillAutonomy(
  ctx: TurnContext,
  engine: TurnEngine,
  charName: string,
  config: LoadedConfig,
  now: Date = new Date(),
): Promise<void> {
  if (!ctx.autonomy.ensureState(charName, config)) return;

  const cutoff = new Date(now.getTime() - ACTIVITY_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const timestamps: Date[] = [];

  const collect = (msgs: readonly Message[]): void => {
    for (const msg of msgs) {
      if (msg.role !== "user" || isToolResultOnly(msg)) continue;
      const at = new Date(msg.timestamp);
      if (!Number.isNaN(at.getTime()) && at >= cutoff) timestamps.push(at);
    }
  };

  collect(engine.messages());
  const segments = engine.segments();
  for (let i = 0; i < segments.segmentCount(); i += 1) {
    try {
      collect(await segments.readSegment(i));
    } catch {
      // An unreadable segment is skipped, as in the Rust: a corrupt archive
      // must not stop the rest of the history from seeding the tracker.
    }
  }

  // An empty list is not passed down. The tracker is left untouched rather than
  // seeded with nothing, which is a different state.
  if (timestamps.length > 0) ctx.autonomy.backfillActivity(charName, timestamps);
}

/** A user turn carrying *only* `tool_result` blocks — the tool loop's own
 *  continuation, not the user saying something. */
function isToolResultOnly(msg: Message): boolean {
  return (
    msg.role === "user" &&
    msg.content_blocks.length > 0 &&
    msg.content_blocks.every((b) => b.type === "tool_result")
  );
}

/**
 * Notify autonomy that the user spoke — but only on a fresh turn with content.
 *
 * A regen is not the user arriving, and neither is an empty body. The turn count
 * is read *after* the append, so it includes the turn just recorded.
 */
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

/**
 * How much of the context window this turn's prompt occupied.
 *
 * Everything sent, cached or not: a cached prompt still fills the window, so
 * counting only `input_tokens` would mean the token trigger never fires once the
 * cache is warm — which is exactly when a conversation is long enough to need
 * compacting. Saturating, so a nonsense provider count cannot wrap to a small
 * number and silently disable compaction.
 */
export function contextTokensFor(usage: Usage): number {
  const sum =
    BigInt(usage.input_tokens) +
    BigInt(usage.cache_read_tokens) +
    BigInt(usage.cache_creation_tokens);
  const ceiling = BigInt("18446744073709551615"); // usize::MAX on the Rust's target
  return Number(sum > ceiling ? ceiling : sum);
}

/**
 * Emit `stream_end` — and only after persistence has finished.
 *
 * A client that fires an immediate follow-up command on seeing this frame (the
 * MCP bridge does) would otherwise race the persist write and read stale engine
 * state. The frame carries the id of the message that was just written and the
 * revision it produced, which is what lets a client attach the finished turn to
 * what it already rendered.
 */
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

/** What an inline compaction needs to run. */
export interface CompactionRunner {
  /** Runs the compaction pass, returning how many messages were retained. */
  run(charName: string, config: LoadedConfig): Promise<number>;
  /** Re-applies the character's deferred self-edits. */
  applyDeferredEdits(characterDataDir: string, configDir: string, charName: string): Promise<void>;
}

/**
 * Check whether this turn crossed a compaction threshold, and run one if so.
 *
 * The Rust spawned a detached task here and returned immediately; the caller is
 * async all the way down now, so the caller decides whether to await. Either way
 * the gate is read before anything is spawned, from a single consistent view of
 * the engine.
 */
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
  const contextTokens = contextTokensFor(result.usage);
  if (!ctx.autonomy.shouldCompactNow(charName, turnCount, contextTokens)) return false;

  await runInlineCompaction(ctx, engine, charName, config, dataDir, rid, runner);
  return true;
}

/**
 * Run a compaction inline, and put the engine back in step with what it wrote.
 *
 * The order matters and is preserved: compact, reload, *then* apply deferred
 * edits. A character's self-edits are applied after the reload because the
 * reload is what busts the cached prompt they would otherwise be written behind.
 *
 * A failed reload returns early without applying them — the engine is out of
 * step with the files at that point, and editing on top of a stale view is worse
 * than skipping. A failed *edit* only warns: the compaction itself succeeded and
 * the conversation is sound, so it is not worth reporting as a compaction
 * failure.
 */
export async function runInlineCompaction(
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

  let retained: number;
  try {
    retained = await runner.run(charName, config);
  } catch (e) {
    console.warn(`shore: inline compaction failed for ${charName}: ${String(e)}`);
    ctx.autonomy.onCompactionFailed(charName);
    return;
  }

  try {
    await engine.reload();
  } catch (e) {
    console.warn(`shore: inline compaction engine reload failed for ${charName}: ${String(e)}`);
    ctx.autonomy.onCompactionFailed(charName);
    return;
  }

  try {
    await runner.applyDeferredEdits(
      characterDataDir(dataDir, charName),
      config.dirs.config,
      charName,
    );
  } catch (e) {
    console.warn(`shore: failed to apply deferred edits after compaction: ${String(e)}`);
  }

  ctx.autonomy.onCompactionComplete(charName, retained);
}
