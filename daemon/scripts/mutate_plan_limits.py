#!/usr/bin/env python3
"""Mutation pass over the Claude plan limits: the reading, polling, the gate,
the warnings, and how plan usage is accounted.
"""
import sys

PLAN = "src/ledger/plan_limits.ts"
FETCH = "src/llm/claude_plan_limits.ts"
GATE = "src/ledger/gate.ts"
RECORD = "src/ledger/record.ts"
USAGE = "src/ledger/usage.ts"
REGISTRY = "src/commands/registry.ts"
PROVIDERS = "src/config/providers.ts"
AGENT = "src/llm/providers/claude_agent.ts"
DEPS = "src/handler/deps.ts"
PERSISTENCE = "src/handler/persistence.ts"

TESTS = [
    "tests/plan_limits.test.ts",
    "tests/claude_plan_limits.test.ts",
    "tests/handler_deps.test.ts",
    "tests/stream.test.ts",
]

MUTANTS = [
    # --- the reading ----------------------------------------------------------
    ("reading: utilization taken as a fraction already, so 31% reads as 3100%",
     FETCH,
     "  return { percent_used: utilization / 100, resets_at: claudePlanInstant(window?.resets_at) };",
     "  return { percent_used: utilization, resets_at: claudePlanInstant(window?.resets_at) };"),
    ("reading: epoch-second resets read as milliseconds",
     PLAN,
     '  if (typeof value === "number") return Number.isFinite(value) ? toRfc3339(value * 1000) : null;',
     '  if (typeof value === "number") return Number.isFinite(value) ? toRfc3339(value) : null;'),
    ("reading: a window keeps its figure after it resets",
     PLAN,
     "  if (reading.resets_at !== null && Date.parse(reading.resets_at) <= now) return { percent_used: 0, resets_at: null };",
     "  if (false) return { percent_used: 0, resets_at: null };"),
    ("reading: a rejection leaves the window's last figure",
     PLAN,
     '  const percent = info.status === "rejected" ? Math.max(1, reported ?? 1) : reported;',
     "  const percent = reported;"),
    ("reading: any limit's event moves the 5-hour window",
     PLAN,
     "  const window = CLAUDE_PLAN_WINDOWS.find((name) => name === info.rateLimitType);",
     "  const window = CLAUDE_PLAN_WINDOWS[0];"),
    ("reading: an event overwrites the window it did not name",
     PLAN,
     '    five_hour: window === "five_hour" ? reading : prior?.five_hour ?? null,',
     "    five_hour: reading,"),
    ("reading: rate-limit events are logged and never read",
     AGENT,
     "    observeClaudeRateLimit(msg.rate_limit_info);\n",
     ""),

    # --- polling --------------------------------------------------------------
    ("poll: a fresh reading is polled again on every call",
     PLAN,
     "  if (refreshing === undefined && now - lastAttempt() < maxAgeMs) return;",
     "  if (refreshing === undefined && false) return;"),
    ("poll: a caller arriving mid-poll starts a second one",
     PLAN,
     "  refreshing ??= pollClaudePlanLimits(fetch, now).finally(() => {",
     "  refreshing = pollClaudePlanLimits(fetch, now).finally(() => {"),
    ("poll: a failed poll is retried on every call",
     PLAN,
     "  attemptedAt = now;\n",
     ""),
    ("poll: a reading is never cached, so a restart forgets it",
     PLAN,
     '    seven_day: newer("seven_day"),\n  };\n  await persist();',
     '    seven_day: newer("seven_day"),\n  };\n  await Promise.resolve();'),
    ("poll: a poll overwrites a rate-limit event that arrived while it ran",
     PLAN,
     "    observed[window] === seen[window] ? poll[window] : prior?.[window] ?? null;",
     "    poll[window];"),
    ("poll: rate-limit events are never counted, so a poll overwrites them",
     PLAN,
     "  observed[window] += 1;\n",
     ""),
    ("poll: the cache is never read back",
     PLAN,
     "  current = cacheDir === undefined ? undefined : readClaudePlanLimits(claudePlanLimitsPath(cacheDir));",
     "  current = undefined;"),
    ("poll: the switch that suppresses the usage fetch is kept",
     FETCH,
     "  return { ...env, ...NONESSENTIAL_EXCEPT_USAGE };\n}",
     "  return agentEnvironment;\n}"),
    ("poll: lifting the usage switch turns telemetry and update checks back on",
     FETCH,
     "  return { ...env, ...NONESSENTIAL_EXCEPT_USAGE };\n}",
     "  return env;\n}"),
    ("poll: the prompt closes before the report arrives",
     FETCH,
     "      prompt: silentUntil(held),",
     "      prompt: silentUntil(Promise.resolve()),"),
    ("poll: the Claude Code session is left running",
     FETCH,
     "    session?.close();\n",
     ""),
    ("poll: every poll scans a week of local transcripts",
     FETCH,
     "({ skipBehaviors: true })",
     "({})"),
    ("poll: background calls go ahead on a stale reading",
     RECORD,
     '    if (isBackgroundCall(req.context?.call_type ?? "message")) await refresh;',
     "    void refresh;"),
    ("poll: conversation waits for the usage report",
     RECORD,
     '    if (isBackgroundCall(req.context?.call_type ?? "message")) await refresh;',
     "    await refresh;"),
    ("poll: a report shows a stale reading without polling",
     USAGE,
     "  void refreshClaudePlanLimits(CLAUDE_PLAN_REPORT_REFRESH_MS, now);\n",
     ""),

    # --- the gate -------------------------------------------------------------
    ("gate: the plan is never consulted",
     GATE,
     "  return costBudgetBlock(request, context, now) ?? claudePlanBlockFor(request, now);",
     "  return costBudgetBlock(request, context, now);"),
    ("gate: providers that never touch the plan are held back by it",
     PLAN,
     '  return request.sdk === "claude_agent";',
     "  return true;"),
    ("gate: the action is ignored, so conversation stops at the limit too",
     PLAN,
     "  const limit = report?.windows.find((item) => item.over_limit && actionBlocks(item.action, context.call_type));",
     "  const limit = report?.windows.find((item) => item.over_limit);"),
    ("gate: landing exactly on the limit still runs",
     PLAN,
     "  const over = reading.percent_used >= policy.limit_fraction;",
     "  const over = reading.percent_used > policy.limit_fraction;"),
    ("gate: the configured policy is ignored",
     PLAN,
     "  return config?.plan_limits?.[window] ?? defaultPlanLimitPolicy();",
     "  return defaultPlanLimitPolicy();"),

    # --- warnings -------------------------------------------------------------
    ("warnings: thresholds are not remembered, so every turn repeats them",
     PLAN,
     '    const fresh = reached.filter((threshold) => recordBudgetWarningThreshold(db, name, "plan", window, threshold, now));',
     "    const fresh = reached;"),
    ("warnings: jitter in the reported reset re-arms every threshold",
     PLAN,
     "    const window = windowKey(resets);",
     "    const window = resets;"),
    ("warnings: reaching the limit is never announced",
     PLAN,
     "    const reached = limit.over_limit ? [...limit.crossed_warn_at, limit.limit_at] : limit.crossed_warn_at;",
     "    const reached = limit.crossed_warn_at;"),
    ("warnings: a character with no usage config never hears about the plan",
     DEPS,
     "    if (claudePlanLimitsState() === undefined) return Promise.resolve([]);",
     "    if (usage(character) === undefined) return Promise.resolve([]);"),
    ("warnings: a turn on another provider spends the plan's thresholds",
     PERSISTENCE,
     "  if (params.onClaudePlan === true) await emitPlanLimitWarnings(ctx, charName, request.rid);",
     "  await emitPlanLimitWarnings(ctx, charName, request.rid);"),
    ("warnings: plan warnings are computed and dropped",
     PERSISTENCE,
     "    ctx.sendDirect({ type: \"plan_limit_warning\", rid: rid ?? null, ...warning });\n",
     ""),

    # --- reports and accounting -----------------------------------------------
    ("report: every conversation's budget report carries the plan",
     USAGE,
     "    const plan = request.claudePlanLimits === true ? currentClaudePlanLimits(config, now) : undefined;",
     "    const plan = currentClaudePlanLimits(config, now);"),
    ("report: a Claude conversation's budget report leaves the plan out",
     REGISTRY,
     'claudePlanLimits: chatModel?.sdk === "claude_agent"',
     "claudePlanLimits: false"),
    ("accounting: a claude_agent provider is billed as metered",
     PROVIDERS,
     '    if (value["subscription"] === undefined && isKeylessSdk(sdk)) out.subscription = true;\n',
     ""),
    ("accounting: an explicit subscription = false is overridden",
     PROVIDERS,
     '    if (value["subscription"] === undefined && isKeylessSdk(sdk)) out.subscription = true;',
     "    if (isKeylessSdk(sdk)) out.subscription = true;"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
