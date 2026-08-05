/**
 * Asking the daemon to run an autonomy action.
 *
 * The tick loop lives here; the four things it can decide to do do not. A
 * heartbeat is a private turn with the whole tool surface, compaction and the
 * deep archive rewrite the conversation on disk, and dreaming sweeps the memory
 * store — all of which reach the filesystem, MCP and sub-agents, none of which
 * live on this side. So each one becomes a call back over the daemon's socket,
 * as line-delimited JSON.
 *
 * # The last thing on this socket
 *
 * It used to share it with the tool loop, which is why the transport below
 * looks like a general-purpose client rather than a caller of one endpoint.
 * The tool loop runs its tools in this process now, so the request union is
 * down to one arm and the transport moved here from `llm/tool_rpc.ts` with it.
 * It goes the same way when `autonomy/manager.rs` ports: a heartbeat is a turn,
 * and a turn is already this side's.
 *
 * # What the answer has to carry
 *
 * More than "it worked". The tick decides on turn counts and writes the
 * heartbeat log, and neither is observable from here — the conversation is on
 * the far side, and so is everything a heartbeat did while it ran. So the
 * daemon reports what changed and the tick folds it in. A response that carried
 * only success would leave the log silent about every autonomous message and
 * the turn count wrong until the next user turn.
 */

import { decodeEvent, type HeartbeatEventKind } from "./heartbeat_log.ts";
import type { AutonomyActionResult, AutonomyExecutor } from "./runner.ts";
import type { CompactionReason } from "./tick.ts";

/**
 * What the daemon can be asked to do, exactly as it appears on the wire.
 *
 * The compaction reason is folded into the action rather than riding beside it:
 * the two reasons are different requests, and it makes "a dream with a reason"
 * unspellable. Mirrors `AutonomyAction` in the daemon.
 */
export type AutonomyAction =
  | "heartbeat_tick"
  | "compact_max_turns"
  | "compact_idle"
  | "deep_archive";

/** The action a compaction reason asks for. */
export function actionForCompaction(reason: CompactionReason): AutonomyAction {
  return reason === "max_turns" ? "compact_max_turns" : "compact_idle";
}

/** One action, as the daemon expects it. */
export interface AutonomyRequest {
  character: string;
  action: AutonomyAction;
}

/** The daemon could not attempt the call at all. Never reaches a model. */
export class DaemonUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnreachable";
  }
}

/**
 * Make one call over the daemon's socket.
 *
 * Line-delimited JSON, one connection per call: write a request and a newline,
 * read an answer and a newline, close. A connection *is* the correlation, so
 * there is no framing, keep-alive, or request id.
 *
 * Resolves with whatever the daemon answered, including an action that failed —
 * telling those apart is {@link decodeActionResult}'s job, because the wire is
 * where the distinction lives. Rejects only when no answer arrived: the socket
 * refused, the connection closed first, or the answer was not JSON.
 */
export async function callDaemon(
  socketPath: string,
  request: { kind: "autonomy" } & AutonomyRequest,
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let close: (() => void) | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      close?.();
      fn();
    };

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          close = () => socket.end();
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(_socket, chunk) {
          buffer += new TextDecoder().decode(chunk);
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          const line = buffer.slice(0, newline);
          finish(() => {
            try {
              resolve(JSON.parse(line));
            } catch (cause) {
              reject(
                new DaemonUnreachable(
                  `daemon answered with something that is not JSON: ${String(cause)}`,
                ),
              );
            }
          });
        },
        error(_socket, error) {
          finish(() => reject(new DaemonUnreachable(String(error))));
        },
        close() {
          // Only reached before an answer — the success path settles first.
          finish(() =>
            reject(new DaemonUnreachable("daemon closed the socket before answering")),
          );
        },
      },
    }).catch((cause: unknown) => {
      finish(() =>
        reject(new DaemonUnreachable(`cannot reach the daemon socket: ${String(cause)}`)),
      );
    });
  });
}

/**
 * Run autonomy actions by asking the daemon over its socket.
 *
 * The socket path is passed in rather than derived here so a test can point at
 * its own.
 */
export class RpcAutonomyExecutor implements AutonomyExecutor {
  readonly #socketPath: string;

  constructor(socketPath: string) {
    this.#socketPath = socketPath;
  }

  async runHeartbeatTick(character: string): Promise<AutonomyActionResult> {
    return await this.#run(character, "heartbeat_tick");
  }

  async runCompaction(
    character: string,
    reason: CompactionReason,
  ): Promise<AutonomyActionResult> {
    return await this.#run(character, actionForCompaction(reason));
  }

  async runDeepArchive(character: string): Promise<AutonomyActionResult> {
    return await this.#run(character, "deep_archive");
  }

  /**
   * One round trip.
   *
   * No timeout. Every action here is an LLM round trip and a slow one is
   * ordinary; the daemon refuses a second action for a character while one is
   * outstanding, so a hang costs that character's autonomy and nothing else.
   * A timeout would instead abandon work that is still running and let the next
   * tick start it again on top.
   */
  async #run(character: string, action: AutonomyAction): Promise<AutonomyActionResult> {
    const outcome = await callDaemon(this.#socketPath, {
      kind: "autonomy",
      character,
      action,
    });
    return decodeActionResult(outcome, character, action);
  }
}

/**
 * Read the daemon's answer, or throw because there wasn't one.
 *
 * The two failure modes stay apart here, where the wire distinguishes them:
 * `{error}` is the daemon saying it could not attempt the action, which throws
 * and abandons the rest of the tick. Anything else is an attempt that
 * completed — including one that completed by failing, which comes back as a
 * result with `failed` set so its log lines survive and its latch releases.
 */
export function decodeActionResult(
  outcome: unknown,
  character: string,
  action: AutonomyAction,
): AutonomyActionResult {
  if (outcome === null || typeof outcome !== "object") {
    throw new DaemonUnreachable(
      `daemon answered ${action} for ${character} with something that is not an object`,
    );
  }
  const o = outcome as Record<string, unknown>;
  if (typeof o["error"] === "string") throw new DaemonUnreachable(o["error"]);

  const turnCount = o["turn_count"];
  const failed = o["failed"];
  return {
    turnCount: typeof turnCount === "number" ? turnCount : undefined,
    events: decodeEvents(o["events"]),
    failed: typeof failed === "string" ? failed : undefined,
  };
}

/**
 * Take the log lines the daemon reported, dropping any it spelled wrongly.
 *
 * Deliberately the same forgiveness `decodeEvent` gives a line read back off
 * disk: an unknown kind costs one entry in a log a person reads, and raising
 * here would turn that into a failed autonomy action. The parity fixture is
 * what actually holds the two spellings together — this is the fallback, not
 * the guard.
 */
function decodeEvents(raw: unknown): { kind: HeartbeatEventKind; detail: string }[] {
  if (!Array.isArray(raw)) return [];
  const events: { kind: HeartbeatEventKind; detail: string }[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const { kind, detail } = entry as Record<string, unknown>;
    if (typeof kind !== "string" || typeof detail !== "string") continue;
    // Reuse the log's own validation rather than a second copy of the kind
    // list; the timestamp is a placeholder, since only `kind` is being checked.
    const decoded = decodeEvent(JSON.stringify({ timestamp: "", kind, detail }));
    if (decoded === undefined) {
      console.warn(`shore: dropping heartbeat event with unknown kind "${kind}"`);
      continue;
    }
    events.push({ kind: decoded.kind, detail: decoded.detail });
  }
  return events;
}
