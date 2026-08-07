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

export interface HeartbeatEngine {
  appendMessage(msg: Message): Promise<void>;
  currentRevision(): number;
}

export interface HeartbeatTickDeps
  extends PrepareHeartbeatDeps,
    Omit<
      HeartbeatLoopDeps,
      "character" | "wrapUpGrace" | "maxToolIterations" | "note" | "generate"
    > {
  generate: HeartbeatLoopDeps["generate"];
  engine?: (character: string) => Promise<HeartbeatEngine>;
  emit?: (character: string, revision: number, msg: Message) => void;
  notify?: (title: string, body: string) => void;
  newId?: () => string;
  nowIso?: () => string;
  budgetBlockFor?: (request: SidecarRequest) => BudgetBlock | undefined;
}

function shortPreview(text: string): string {
  return [...text].slice(0, 80).join("");
}

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

  deps.notify?.(`Shore — ${character}`, msg.content);

  note("message_sent", `Autonomous message sent: ${shortPreview(msg.content)}`);
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

  const prepared = await prepareHeartbeatRequest(character, config, deps);
  if (prepared === undefined) return { events };

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

  await persistHeartbeatMessage(character, prepared.request, loop, deps, note);

  return { events };
}
