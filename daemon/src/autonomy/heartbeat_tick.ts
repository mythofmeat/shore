/**
 * A heartbeat tick, end to end: build the body, run the loop, deliver whatever
 * the character asked to say.
 *
 * Ported from `execute_heartbeat_tick` and `persist_heartbeat_message` in
 * `crates/daemon/src/autonomy/manager.rs`. The two halves it strings together
 * are `heartbeat_request.ts` and `heartbeat_loop.ts`.
 *
 * # Delivery is best-effort in three separate ways
 *
 * A tick's conversation is thrown away, so the message is the only chance the
 * character has to be heard, and every step of getting it out can fail
 * independently: the engine may refuse the append, there may be no client
 * connected to push to, the desktop notifier may be absent. The Rust let each of
 * those fail on its own and carried on, and so does this. In particular the
 * notification fires even when the append failed — the character did speak, and
 * a user who is told they have a message and finds nothing in the log is better
 * off than one who is never told at all.
 *
 * # An image-only tick still delivers
 *
 * `<sendMessage>` is not the only way to say something. A tick that generated an
 * image and wrote no text has still produced something for the user, so the
 * image is the message and any words ride along as its caption.
 */

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
import { budgetBlockFor } from "../ledger/gate.ts";
import type { BudgetBlock } from "../ledger/budget.ts";
import type { SidecarRequest } from "../llm/types.ts";

/** The engine half of delivery: append to the conversation, and say where. */
export interface HeartbeatEngine {
  appendMessage(msg: Message): Promise<void>;
  currentRevision(): number;
}

/** What the tick needs beyond its own two halves. */
export interface HeartbeatTickDeps
  extends PrepareHeartbeatDeps,
    Omit<
      HeartbeatLoopDeps,
      "character" | "wrapUpGrace" | "maxToolIterations" | "note" | "generate"
    > {
  /**
   * One model call, given the resolved model so the ledger row and the
   * credential rotation know what they are recording.
   */
  generate: HeartbeatLoopDeps["generate"];
  /** The character's conversation. Absent means nothing can be persisted. */
  engine?: (character: string) => Promise<HeartbeatEngine>;
  /** Push the delivered message to connected clients. */
  emit?: (character: string, revision: number, msg: Message) => void;
  /** Desktop notification, when one is configured. */
  notify?: (title: string, body: string) => void;
  newId?: () => string;
  nowIso?: () => string;
  /** The budget pre-flight. Defaults to the real gate; injected only by tests,
   *  which have no ledger to answer from. */
  budgetBlockFor?: (request: SidecarRequest) => BudgetBlock | undefined;
}

/** The first 80 characters, as `chars().take(80)` counts them. */
function shortPreview(text: string): string {
  return [...text].slice(0, 80).join("");
}

/**
 * Deliver a tick's output, or record that there was none.
 *
 * The four things that happen on delivery are ordered as the Rust ordered them:
 * persist, push, notify, log. Persisting first is what makes the pushed
 * revision a revision that exists.
 */
export async function persistHeartbeatMessage(
  character: string,
  request: SidecarRequest,
  loop: HeartbeatLoopResult,
  deps: Pick<HeartbeatTickDeps, "engine" | "emit" | "notify" | "newId" | "nowIso">,
  note: (kind: HeartbeatEventKind, detail: string) => void,
): Promise<void> {
  if (loop.sendMessageText === undefined && loop.images.length === 0) {
    note("message_skipped", "Tick completed — no message sent");
    return;
  }

  const text = loop.sendMessageText ?? "";
  console.info(
    `shore: heartbeat for ${character} sending a message (images=${loop.images.length})`,
  );

  // The model that actually wrote this — the background one when the override
  // applied, chat's otherwise. An empty string is the absence, not a name.
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
    // An absent caption stays absent rather than becoming an explicit
    // `undefined`: the stored shape is what lands in `active.jsonl`, and the
    // key being present with a null value is a difference every reader has to
    // handle for no gain.
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
  };

  if (deps.engine === undefined) {
    console.error(`shore: heartbeat for ${character} has no engine, message not persisted`);
  } else {
    try {
      const engine = await deps.engine(character);
      await engine.appendMessage(msg);
      deps.emit?.(character, engine.currentRevision(), msg);
    } catch (e) {
      console.error(
        `shore: heartbeat could not persist the autonomous message for ${character}: ${String(e)}`,
      );
    }
  }

  // Deliberately outside the branch above. The character spoke; a user told
  // about a message that failed to persist is better served than one who is
  // never told at all.
  deps.notify?.(`Shore — ${character}`, msg.content);

  note("message_sent", `Autonomous message sent: ${shortPreview(msg.content)}`);
}

/**
 * Run one tick.
 *
 * Nothing here throws for a heartbeat that simply did not happen. A body that
 * cannot be built is a skip with no events, which is what leaves the clock free
 * to try again on its own schedule.
 */
export async function runHeartbeatTick(
  character: string,
  config: LoadedConfig,
  deps: HeartbeatTickDeps,
): Promise<AutonomyActionResult> {
  const events: { kind: HeartbeatEventKind; detail: string }[] = [];
  const note = (kind: HeartbeatEventKind, detail: string): void => {
    events.push({ kind, detail });
  };

  const prepared = await prepareHeartbeatRequest(character, config, deps);
  if (prepared === undefined) return { events };

  // The pre-flight the keepalive has had all along (`keepalive.ts`, the
  // `budgetBlockFor` before `#send`). Without it a paused heartbeat is not
  // paused at all: the tick builds its whole request, reaches the gate inside
  // `generate`, and throws `BudgetBlocked` — once per tick, for as long as the
  // budget is over. Same decision, taken one layer earlier, where "skip" is a
  // thing the tick can actually do.
  const blocked = (deps.budgetBlockFor ?? budgetBlockFor)(prepared.request);
  if (blocked !== undefined) {
    note("budget_paused", `Tick skipped — usage budget "${blocked.budget_name}"`);
    return { events };
  }

  const loop = await runHeartbeatToolLoop(prepared.request, {
    ...deps,
    character,
    wrapUpGrace: config.app.behavior.autonomy.heartbeat.wrap_up_grace_rounds,
    maxToolIterations: prepared.maxToolIterations,
    note: (detail) => note("tool_use", detail),
  });

  // A tick that ran on the keepalive's own model warmed its cache; one on a
  // pinned background model — the common case — did not, and must not push the
  // foreground ping schedule out. That distinction is the keepalive's to make:
  // it sees the call land and compares the model itself, rather than being told
  // about it from here.
  await persistHeartbeatMessage(character, prepared.request, loop, deps, note);

  return { events };
}
