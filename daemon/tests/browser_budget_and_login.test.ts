import { describe, expect, test } from "bun:test";

import { budgetLevel, budgetWarning, focusedBudget, levelWarning, showPlanLimit, showUsage, type DisplayBudget } from "../src/browser/budget_display.ts";
import { DEFAULT_WEB_PORT, deviceOrigin, loginCodeIn, loginLink, loopbackOrigin } from "../src/browser/login_link.ts";

const level = (percent: number, overLimit = false, crossed: number[] = []) => ({ percent_used: percent, over_limit: overLimit, crossed_warn_at: crossed });
const budget = (name: string, cap: ReturnType<typeof level>, pace?: ReturnType<typeof level>): DisplayBudget => ({ name, ...cap, ...(pace === undefined ? {} : { pace }) });

describe("the budget readout", () => {
  test("warns once a level is over its limit or past a warning mark, on either its cap or its pace", () => {
    expect(levelWarning(level(10))).toBe(false);
    expect(levelWarning(level(10, true))).toBe(true);
    expect(levelWarning(level(10, false, [50]))).toBe(true);
    expect(budgetWarning(budget("a", level(10)))).toBe(false);
    expect(budgetWarning(budget("a", level(10), level(20)))).toBe(false);
    expect(budgetWarning(budget("a", level(10), level(20, true)))).toBe(true);
    expect(budgetWarning(budget("a", level(10, false, [5]), level(20)))).toBe(true);
  });

  test("shows the cap or the pace asked for, and on auto whichever warns, else whichever is fuller", () => {
    const quiet = budget("a", level(40), level(30));
    expect(budgetLevel(quiet, "cap")).toEqual({ level: quiet, scope: "cap" });
    expect(budgetLevel(quiet, "pace")).toEqual({ level: level(30), scope: "pace" });
    expect(budgetLevel(budget("a", level(40)), "pace").scope, "no pace to show").toBe("cap");
    expect(budgetLevel(quiet, "auto").scope).toBe("cap");
    expect(budgetLevel(budget("a", level(40), level(60)), "auto").scope).toBe("pace");
    expect(budgetLevel(budget("a", level(40), level(40)), "auto").scope, "a tie stays on the cap").toBe("cap");
    expect(budgetLevel(budget("a", level(40), level(10, false, [5])), "auto").scope, "a warning beats fullness").toBe("pace");
    expect(budgetLevel(budget("a", level(40, true), level(90)), "auto").scope).toBe("cap");
    expect(budgetLevel(budget("a", level(40, true), level(90, true)), "auto").scope, "both warn, so the fuller").toBe("pace");
    expect(budgetLevel(budget("a", level(40)), "auto").scope).toBe("cap");
  });

  test("focuses the fullest budget, or the one named in any case, at the scope asked for", () => {
    const budgets = [budget("Monthly", level(30), level(80)), budget("daily", level(60), level(20))];
    expect(focusedBudget(budgets, "cap")?.budget.name).toBe("daily");
    expect(focusedBudget(budgets, "pace")?.budget.name).toBe("Monthly");
    expect(focusedBudget(budgets, "auto")).toMatchObject({ budget: { name: "Monthly" }, scope: "pace" });
    expect(focusedBudget([budget("a", level(50)), budget("b", level(50))], "cap")?.budget.name, "a tie goes to the later one").toBe("b");
    expect(focusedBudget(budgets, "monthly:cap")).toMatchObject({ budget: { name: "Monthly" }, level: { percent_used: 30 }, scope: "cap" });
    expect(focusedBudget(budgets, "weekly")).toBeUndefined();
    expect(focusedBudget([], "auto")).toBeUndefined();
    expect(() => focusedBudget(budgets, "monthly:never")).toThrow();
  });

  test("shows usage always, never, or only when it warns", () => {
    const calm = budget("a", level(10));
    const warning = budget("a", level(10, false, [5]));
    expect([showUsage("off", warning), showUsage("always", calm), showUsage("warn", calm), showUsage("warn", warning)]).toEqual([false, true, false, true]);
    expect(() => showUsage("sometimes", calm)).toThrow("Unsupported usage display mode: sometimes");
    expect([showPlanLimit("warn", level(90)), showPlanLimit("warn", level(90, true)), showPlanLimit("always", level(0))]).toEqual([false, true, true]);
  });
});

describe("signing in another device", () => {
  test("a link carries its code in the fragment, and only a well-formed code is read back", () => {
    const code = "a".repeat(43);
    expect(loginLink("https://shore.local", code)).toBe(`https://shore.local/#login=${code}`);
    expect(loginCodeIn(`#login=${code}`)).toBe(code);
    expect(loginCodeIn(`#login=${"a".repeat(42)}`)).toBeUndefined();
    expect(loginCodeIn(`#login=${code}x`)).toBeUndefined();
    expect(loginCodeIn(`#login=${"a".repeat(42)}!`)).toBeUndefined();
    expect(loginCodeIn(`x#login=${code}`)).toBeUndefined();
    expect(loginCodeIn("")).toBeUndefined();
  });

  test("an address typed for a device becomes its origin, on shore's web port unless one is given", () => {
    expect(deviceOrigin("  ")).toBeUndefined();
    expect(deviceOrigin("desktop.lan")).toBe(`http://desktop.lan:${String(DEFAULT_WEB_PORT)}`);
    expect(deviceOrigin("desktop.lan:8080")).toBe("http://desktop.lan:8080");
    expect(deviceOrigin("https://shore.example.org"), "an explicit scheme keeps its own port").toBe("https://shore.example.org");
    expect(deviceOrigin("HTTP://Desktop.LAN:7340/")).toBe("http://desktop.lan:7340");
    for (const refused of ["ftp://desktop.lan", "http://user:pass@desktop.lan", "http://desktop.lan/path", "http://desktop.lan/?x=1", "http://desktop.lan/#x", "http://[bad", "ws://desktop.lan"]) {
      expect(deviceOrigin(refused), refused).toBeUndefined();
    }
  });

  test("a loopback origin is recognised by name or address", () => {
    for (const origin of ["http://localhost:7340", "http://shore.localhost", "http://[::1]:7340", "http://127.0.0.1", "http://127.5.6.7:80"]) expect(loopbackOrigin(origin), origin).toBe(true);
    for (const origin of ["http://localhost.example", "http://128.0.0.1", "http://desktop.lan", "http://127.0.0.1.example"]) expect(loopbackOrigin(origin), origin).toBe(false);
  });
});
