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

describe("a model that is finished", () => {
  test("ends the loop on its first answer, having dispatched nothing", async () => {
    const r = await run({ toolTurns: 0 });
    expect(r).toMatchObject({ stop: "model_done", modelCalls: 1, dispatches: 0, userTurns: 0 });
    expect(r.log).toEqual(["call1"]);
  });

  test("is not called again just because a cap was configured", async () => {
    expect((await run({ toolTurns: 0, maxIterations: 3 })).modelCalls).toBe(1);
  });
});

describe("a model that asks for tools", () => {
  test("has each request dispatched, then is asked again", async () => {
    const r = await run({ toolTurns: 2 });
    expect(r.stop).toBe("model_done");
    expect(r.log).toEqual(["call1", "dispatch1", "call2", "dispatch2", "call3"]);
    expect(r).toMatchObject({ modelCalls: 3, dispatches: 2, userTurns: 2 });
  });

  test("gets one tool-results turn appended per dispatch, never more", async () => {
    for (const toolTurns of [0, 1, 3, 10]) {
      const r = await run({ toolTurns });
      expect(r.userTurns, `${toolTurns} tool turns`).toBe(r.dispatches);
    }
  });

  test("runs as long as it keeps asking, when nothing caps it", async () => {
    const r = await run({ toolTurns: 10 });
    expect(r).toMatchObject({ stop: "model_done", modelCalls: 11, dispatches: 10 });
  });
});

describe("a seeded first turn", () => {
  test("is used instead of calling the model, when it is already finished", async () => {
    const r = await run({ toolTurns: 0, initial: "seeded_end_turn" });
    expect(r).toMatchObject({ stop: "model_done", lastTurn: "seeded", modelCalls: 0 });
    expect(r.log).toEqual([]);
  });

  test("is dispatched like any other, when it asks for tools", async () => {
    const r = await run({ toolTurns: 0, initial: "seeded_tool_use" });
    expect(r.dispatches).toBe(1);
    expect(r.log).toEqual(["dispatch1", "call1"]);
  });
});

describe("the finish reason decides, not the presence of tool blocks", () => {
  test("a turn saying end_turn stops the loop even while asking for tools", async () => {
    const r = await run({ toolTurns: 3, mode: "always_end_turn" });
    expect(r).toMatchObject({ stop: "model_done", dispatches: 0, modelCalls: 1 });
  });

  test("a turn saying tool_use with no tool blocks still stops, since there is nothing to run", async () => {
    const r = await run({ toolTurns: 0, mode: "always_tool_use" });
    expect(r).toMatchObject({ stop: "model_done", dispatches: 0 });
  });
});

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

describe("what happens at the cap depends on cap_behavior", () => {
  test("stop_after_dispatch returns the turn that asked, without a closing call", async () => {
    const r = await run({ toolTurns: 10, maxIterations: 1, cap: "stop_after_dispatch" });
    expect(r).toMatchObject({ stop: "cap_reached", modelCalls: 1, dispatches: 1 });
    expect(r.log).toEqual(["call1", "dispatch1"]);
  });

  test("close_with_final_turn spends one more call so the model can wrap up", async () => {
    const r = await run({ toolTurns: 10, maxIterations: 1, cap: "close_with_final_turn" });
    expect(r).toMatchObject({ stop: "cap_reached", modelCalls: 2, dispatches: 1 });
    expect(r.log).toEqual(["call1", "dispatch1", "call2"]);
  });

  test("the two differ by exactly one model call whenever the cap is what stopped it", async () => {
    for (const max of [1, 2, 3]) {
      const after = await run({ toolTurns: 10, maxIterations: max, cap: "stop_after_dispatch" });
      const closed = await run({ toolTurns: 10, maxIterations: max, cap: "close_with_final_turn" });
      expect(after.stop).toBe("cap_reached");
      expect(closed.modelCalls - after.modelCalls, `max=${max}`).toBe(1);
      expect(closed.dispatches).toBe(after.dispatches);
    }
  });
});

describe("across every combination the loop supports", () => {
  const MODES: FinishReasonMode[] = ["natural", "always_end_turn", "always_tool_use"];
  const INITIALS: Initial[] = ["none", "seeded_end_turn", "seeded_tool_use"];
  const CAPS: CapBehavior[] = ["stop_after_dispatch", "close_with_final_turn"];

  test("the log alternates a call with the dispatch that follows it", async () => {
    for (const mode of MODES) {
      for (const initial of INITIALS) {
        for (const toolTurns of [0, 1, 3, 10]) {
          for (const max of [undefined, 0, 1, 2, 3]) {
            for (const cap of CAPS) {
              const r = await run({ toolTurns, mode, initial, maxIterations: max, cap });
              const where = `${mode}/${initial}/${toolTurns}/${max ?? "none"}/${cap}`;
              const calls = r.log.filter((l) => l.startsWith("call"));
              const dispatches = r.log.filter((l) => l.startsWith("dispatch"));
              expect(calls, where).toHaveLength(r.modelCalls);
              expect(dispatches, where).toHaveLength(r.dispatches);
              expect(r.userTurns, where).toBe(r.dispatches);
              if (max !== undefined) expect(r.dispatches, where).toBeLessThanOrEqual(max);
              expect(r.lastTurn, where).toBeTruthy();
            }
          }
        }
      }
    }
  });

  test("it always terminates and always names why it stopped", async () => {
    for (const toolTurns of [0, 1, 10]) {
      for (const max of [undefined, 0, 2]) {
        const r = await run({ toolTurns, maxIterations: max });
        expect(["model_done", "cap_reached"]).toContain(r.stop);
      }
    }
  });
});
