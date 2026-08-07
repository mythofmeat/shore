/**
 * The shape every tool loop has in common.
 *
 * Ported from `crates/daemon/src/engine/tool_loop.rs`, which had already done
 * the hard part: Shore ran three hand-written copies of this control flow — the
 * chat path, the compaction pass, and the dreaming librarian — and they had
 * drifted on the one part of it that is a genuine policy choice, namely whether
 * a loop that hits its cap gives the model a final turn to see the results it
 * just asked for. That choice is [`CapBehavior`], named and made at the call
 * site, and it is preserved here exactly.
 *
 * # Why this is not `stopWhen: stepCountIs(n)`
 *
 * The AI SDK has a loop, and it is not this one. Two differences, both silent:
 *
 *   1. **The cap counts dispatch rounds, not model calls.** `stepCountIs(n)`
 *      counts steps, where a step is a model call plus its tools. A request
 *      configured for `max_tool_iterations: 2` gets three model calls out of
 *      the Rust and two out of `stepCountIs(2)`.
 *   2. **`CloseWithFinalTurn` spends a call after the cap.** The chat path's
 *      return value is the reply a user reads, so a capped run still lets the
 *      model answer with the last tool results in hand. The SDK just stops, so
 *      the user would get the tool-request turn as their reply.
 *
 * Neither shows up as an error. Both are pinned by
 * `tests/engine_fixtures/tool_loop_parity.json`, generated from the Rust.
 */

/**
 * A tool the model asked for. Mirrors the Rust `ToolUseEvent`; the loop only
 * ever counts these and hands them to the driver, so nothing here inspects
 * `input`.
 */
export interface ToolUseEvent {
  id: string;
  name: string;
  input: unknown;
}

/** Whether a loop that hits its iteration cap gets one more model turn. */
export type CapBehavior =
  /**
   * Stop the moment the cap is reached. The tool results from the final round
   * are appended to the request but never sent — the caller's output comes from
   * what it accumulated, not from a closing message.
   */
  | "stop_after_dispatch"
  /**
   * Send the final round's tool results and let the model answer. Costs one
   * extra call, and is what a caller whose return value is a user-visible reply
   * needs.
   */
  | "close_with_final_turn";

/** Why the loop stopped. */
export type LoopStop =
  /** The model returned a turn that asked for no tools. */
  | "model_done"
  /** The iteration cap was reached. */
  | "cap_reached";

export interface LoopOutcome<Turn> {
  stop: LoopStop;
  lastTurn: Turn;
}

/**
 * The parts of a tool loop that genuinely differ between callers.
 *
 * Appending the assistant turn is the driver's job, not [`runToolLoop`]'s, and
 * each caller does it at a different point: the background passes append inside
 * `callModel`, because every turn they see comes from there; the chat path
 * appends inside `dispatch`, because its first turn was streamed by its caller
 * and never passes through `callModel` at all. Only the tool-result turn is
 * identical everywhere, so that is the one the loop owns.
 */
export interface ToolLoopDriver<Turn> {
  finishReason(turn: Turn): string;
  toolUses(turn: Turn): ToolUseEvent[];

  /** Call the model with the current request. */
  callModel(): Promise<Turn>;

  /**
   * Run one round of tool uses. Tool failures come back as result blocks with
   * `is_error` set, never as a throw — a failed tool is something the model is
   * told about, not something that ends the loop.
   *
   * `turn` is the response that asked for these tools, passed because every
   * caller needs it: to append the assistant turn, to emit a stream boundary,
   * or to pair a transcript row with the tools it went on to call.
   *
   * Appending the tool-result turn to the request is the loop's job, not the
   * driver's; `appendToolResults` is how the loop does it.
   */
  dispatch(turn: Turn, uses: ToolUseEvent[]): Promise<void>;

  /** Append the round's tool-result turn to the request being built. */
  appendToolResults(): void;
}

/**
 * Drive a tool loop to completion.
 *
 * `initial` is the turn the loop starts from, for callers that already made the
 * first model call before entering (the chat path streams it, so the caller has
 * it in hand). `undefined` means make that call here.
 *
 * `maxIterations` counts *dispatch rounds*, not model calls. `undefined` is
 * unlimited, so the only exit is the model ending cleanly or a throw.
 */
export async function runToolLoop<Turn>(
  driver: ToolLoopDriver<Turn>,
  initial: Turn | undefined,
  maxIterations: number | undefined,
  cap: CapBehavior,
): Promise<LoopOutcome<Turn>> {
  let turn = initial ?? (await driver.callModel());
  let iteration = 0;

  for (;;) {
    const uses = driver.toolUses(turn);
    if (uses.length === 0 || driver.finishReason(turn) !== "tool_use") {
      return { stop: "model_done", lastTurn: turn };
    }

    // Reachable only for `maxIterations === 0`: every other path returns below
    // the moment the cap is met, so the loop never comes back around with it
    // already reached. Without this, a cap of zero would run one round — which
    // is what the compaction copy did.
    if (maxIterations !== undefined && iteration >= maxIterations) {
      return { stop: "cap_reached", lastTurn: turn };
    }

    await driver.dispatch(turn, uses);
    driver.appendToolResults();
    iteration += 1;

    const capReached = maxIterations !== undefined && iteration >= maxIterations;
    if (capReached && cap === "stop_after_dispatch") {
      return { stop: "cap_reached", lastTurn: turn };
    }

    turn = await driver.callModel();

    if (capReached) {
      return { stop: "cap_reached", lastTurn: turn };
    }
  }
}
