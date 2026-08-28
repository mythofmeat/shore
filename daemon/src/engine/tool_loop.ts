export interface ToolUseEvent {
  id: string;
  name: string;
  input: unknown;
  input_error?: string;
}

export type CapBehavior =
  | "stop_after_dispatch"
  | "close_with_final_turn";

export type LoopStop =
  | "model_done"
  | "cap_reached";

export interface LoopOutcome<Turn> {
  stop: LoopStop;
  lastTurn: Turn;
}

export interface ToolLoopDriver<Turn> {
  finishReason(turn: Turn): string;
  toolUses(turn: Turn): ToolUseEvent[];

  callModel(): Promise<Turn>;

  dispatch(turn: Turn, uses: ToolUseEvent[]): Promise<void>;

  appendToolResults(): void | Promise<void>;
}

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

    if (maxIterations !== undefined && iteration >= maxIterations) {
      return { stop: "cap_reached", lastTurn: turn };
    }

    await driver.dispatch(turn, uses);
    await driver.appendToolResults();
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
