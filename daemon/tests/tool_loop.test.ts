import { describe, expect, test } from "bun:test";

import {
  runToolLoop,
  type CapBehavior,
  type LoopStop,
  type ToolLoopDriver,
  type ToolUseEvent,
} from "../src/engine/tool_loop.ts";

type FinishReasonMode = "natural" | "always_end_turn" | "always_tool_use";

type Initial = "none" | "seeded_end_turn" | "seeded_tool_use";

interface FakeTurn {
  asksForTools: boolean;
  finishReason?: string | undefined;
  label: string;
}

function overrideFor(mode: FinishReasonMode): string | undefined {
  if (mode === "always_end_turn") return "end_turn";
  if (mode === "always_tool_use") return "tool_use";
  return undefined;
}

class FakeDriver implements ToolLoopDriver<FakeTurn> {
  calls = 0;
  dispatches = 0;
  log: string[] = [];
  userTurns = 0;

  constructor(
    private toolTurnsRemaining: number,
    private mode: FinishReasonMode,
  ) {}

  finishReason(turn: FakeTurn): string {
    return turn.finishReason ?? (turn.asksForTools ? "tool_use" : "end_turn");
  }

  toolUses(turn: FakeTurn): ToolUseEvent[] {
    return turn.asksForTools ? [{ id: "tu", name: "read", input: {} }] : [];
  }

  callModel(): Promise<FakeTurn> {
    this.calls += 1;
    const asksForTools = this.toolTurnsRemaining > 0;
    this.toolTurnsRemaining = Math.max(0, this.toolTurnsRemaining - 1);
    const label = `call${this.calls}`;
    this.log.push(label);
    return Promise.resolve({ asksForTools, finishReason: overrideFor(this.mode), label });
  }

  dispatch(): Promise<void> {
    this.dispatches += 1;
    this.log.push(`dispatch${this.dispatches}`);
    return Promise.resolve();
  }

  appendToolResults(): void {
    this.userTurns += 1;
  }
}

function seededTurn(initial: Initial, mode: FinishReasonMode): FakeTurn | undefined {
  if (initial === "none") return undefined;
  return {
    asksForTools: initial === "seeded_tool_use",
    finishReason: overrideFor(mode),
    label: "seeded",
  };
}

interface Run {
  stop: LoopStop;
  lastTurn: string;
  modelCalls: number;
  dispatches: number;
  log: string[];
  userTurns: number;
}

async function run(opts: {
  toolTurns: number;
  mode?: FinishReasonMode;
  initial?: Initial;
  maxIterations?: number | undefined;
  cap?: CapBehavior;
}): Promise<Run> {
  const mode = opts.mode ?? "natural";
  const driver = new FakeDriver(opts.toolTurns, mode);
  const outcome = await runToolLoop(
    driver,
    seededTurn(opts.initial ?? "none", mode),
    opts.maxIterations,
    opts.cap ?? "stop_after_dispatch",
  );
  return {
    stop: outcome.stop,
    lastTurn: outcome.lastTurn.label,
    modelCalls: driver.calls,
    dispatches: driver.dispatches,
    log: driver.log,
    userTurns: driver.userTurns,
  };
}

describe("the iteration cap", () => {
  test("stops the loop once it is reached, and says so", async () => {
    const r = await run({ toolTurns: 10, maxIterations: 2 });
    expect(r.stop).toBe("cap_reached");
    expect(r.dispatches).toBe(2);
  });

  test("of zero refuses the first dispatch rather than allowing one", async () => {
    const r = await run({ toolTurns: 3, maxIterations: 0 });
    expect(r).toMatchObject({ stop: "cap_reached", dispatches: 0, modelCalls: 1 });
  });

  test("never allows more rounds than it names", async () => {
    for (const max of [0, 1, 2, 3]) {
      for (const toolTurns of [0, 1, 3, 10]) {
        const r = await run({ toolTurns, maxIterations: max });
        expect(r.dispatches, `max=${max} toolTurns=${toolTurns}`).toBeLessThanOrEqual(max);
      }
    }
  });

  test("does not fire when the model finishes first", async () => {
    expect((await run({ toolTurns: 1, maxIterations: 5 })).stop).toBe("model_done");
  });
});
