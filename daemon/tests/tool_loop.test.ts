import { describe, expect, test } from "bun:test";

import {
  runToolLoop,
  type CapBehavior,
  type LoopStop,
  type ToolLoopDriver,
  type ToolUseEvent,
} from "../src/engine/tool_loop.ts";

import fixture from "./engine_fixtures/tool_loop.json" with { type: "json" };

type FinishReasonMode = "natural" | "always_end_turn" | "always_tool_use";

interface Case {
  finish_reason_mode: FinishReasonMode;
  initial: "none" | "seeded_end_turn" | "seeded_tool_use";
  tool_turns: number;
  max_iterations: number | null;
  cap_behavior: CapBehavior;
  stop: LoopStop;
  last_turn: string;
  model_calls: number;
  dispatch_rounds: number;
  log: string[];
  user_turns_appended: number;
}

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

function seededTurn(initial: Case["initial"], mode: FinishReasonMode): FakeTurn | undefined {
  if (initial === "none") return undefined;
  return {
    asksForTools: initial === "seeded_tool_use",
    finishReason: overrideFor(mode),
    label: "seeded",
  };
}

const cases = fixture.cases as Case[];

describe("tool loop parity", () => {
  test("the fixture covers every corner of the sweep", () => {
    expect(cases.length).toBe(450);
    expect(new Set(cases.map((c) => c.initial)).size).toBe(3);
    expect(new Set(cases.map((c) => c.cap_behavior)).size).toBe(2);
    expect(new Set(cases.map((c) => c.max_iterations)).size).toBe(5);
    expect(new Set(cases.map((c) => c.finish_reason_mode)).size).toBe(3);
    expect(new Set(cases.map((c) => c.stop))).toEqual(
      new Set(["model_done", "cap_reached"]),
    );
  });

  test("a contradicting finish_reason stops the loop even with tool blocks present", () => {
    const lying = cases.filter(
      (c) => c.finish_reason_mode === "always_end_turn" && c.tool_turns > 0,
    );
    expect(lying.length).toBeGreaterThan(0);
    for (const c of lying) {
      expect(c.stop).toBe("model_done");
      expect(c.dispatch_rounds).toBe(0);
    }
  });

  for (const [index, c] of cases.entries()) {
    const name =
      `#${index} finish=${c.finish_reason_mode} initial=${c.initial} ` +
      `tool_turns=${c.tool_turns} max=${c.max_iterations ?? "none"} cap=${c.cap_behavior}`;

    test(name, async () => {
      const driver = new FakeDriver(c.tool_turns, c.finish_reason_mode);
      const outcome = await runToolLoop(
        driver,
        seededTurn(c.initial, c.finish_reason_mode),
        c.max_iterations ?? undefined,
        c.cap_behavior,
      );

      expect(outcome.stop).toBe(c.stop);
      expect(outcome.lastTurn.label).toBe(c.last_turn);
      expect(driver.calls).toBe(c.model_calls);
      expect(driver.dispatches).toBe(c.dispatch_rounds);
      expect(driver.log).toEqual(c.log);
      expect(driver.userTurns).toBe(c.user_turns_appended);
    });
  }
});
