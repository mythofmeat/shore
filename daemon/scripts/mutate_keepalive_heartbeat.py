#!/usr/bin/env python3
"""Mutation pass over a heartbeat refreshing the chat keepalive: which
heartbeats count, the cache size they arm, and the ping schedule they move.
"""
import sys

K = "src/cache/keepalive.ts"
S = "src/cache/schedule.ts"
L = "src/cache/last_request.ts"
P = "src/handler/persistence.ts"

TESTS = [
    "tests/keepalive_service.test.ts",
    "tests/keepalive_heartbeat.test.ts",
    "tests/keepalive_wiring.test.ts",
    "tests/last_request.test.ts",
]

REFRESH_GUARD = '  if (heartbeat.sdk === "claude_agent" || haltKey(heartbeat) !== haltKey(armed)) return false;'
COVERED = "  return cached > 0 && usage.cache_read_tokens >= cached;"
ARMED_SIZE = "    cachedTokens: cachedPrefixTokens(result.context_usage ?? result.usage),"

MUTANTS = [
    # --- the signal ------------------------------------------------------------
    ("observe: a heartbeat is ignored again, so its refresh never moves the ping",
     K,
     "      this.#observeHeartbeat(character, usage, identity);\n      return;",
     "      return;"),
    ("observe: a heartbeat is recorded like a real call",
     K,
     '    if (callType === "heartbeat") {\n      this.#observeHeartbeat(character, usage, identity);\n      return;\n    }\n',
     ""),
    ("observe: the later rounds of the heartbeat's tool loop count like its first",
     K,
     '    if (callType === "heartbeat") {',
     '    if (callType === "heartbeat" || callType === "heartbeat_tool_loop") {'),
    ("observe: the push revives a schedule a cold ping stopped",
     K,
     "    if (entry.keepalive.nextPingAt === undefined || !heartbeatRefreshedPrefix(armed, identity, usage)) return;",
     "    if (!heartbeatRefreshedPrefix(armed, identity, usage)) return;"),
    ("observe: the push is booked as activity, moving the idle ceiling and giving the count back",
     K,
     "    entry.keepalive.onPrefixWarmed(this.#now());",
     "    entry.keepalive.onCacheWarmed(armed.model, this.#now());"),

    # --- the predicate ---------------------------------------------------------
    ("refresh: a claude_agent heartbeat counts, though its usage sums a session of its own",
     K,
     REFRESH_GUARD,
     "  if (haltKey(heartbeat) !== haltKey(armed)) return false;"),
    ("refresh: a heartbeat on another model or provider counts",
     K,
     REFRESH_GUARD,
     '  if (heartbeat.sdk === "claude_agent") return false;'),
    ("refresh: only the model ID is compared, so the same model through another provider counts",
     K,
     REFRESH_GUARD,
     '  if (heartbeat.sdk === "claude_agent" || heartbeat.model !== armed.model) return false;'),
    ("refresh: a heartbeat on another thread counts",
     K,
     "  if ((heartbeat.context?.thread ?? MAIN_THREAD) !== (armed.context?.thread ?? MAIN_THREAD)) return false;\n",
     ""),
    ("refresh: an unmeasured prefix is covered by any read",
     K,
     "  const cached = armed.keepalive_cached_tokens ?? 0;",
     "  const cached = armed.keepalive_cached_tokens ?? 1;"),
    ("refresh: a turn that left nothing cached is covered by any read, even none",
     K,
     COVERED,
     "  return usage.cache_read_tokens >= cached;"),
    ("refresh: any read counts, though it stopped at the system prompt",
     K,
     COVERED,
     "  return cached > 0 && usage.cache_read_tokens > 0;"),
    ("refresh: a read of exactly the armed prefix does not count",
     K,
     COVERED,
     "  return cached > 0 && usage.cache_read_tokens > cached;"),

    # --- the measurement -------------------------------------------------------
    ("size: the write is left out, so a read that stopped short of the turn's new tail counts",
     K,
     "  return usage.cache_read_tokens + usage.cache_creation_tokens;",
     "  return usage.cache_read_tokens;"),
    ("arming: the turn's usage summed over its rounds, which no single read covers once it ran a tool",
     P,
     ARMED_SIZE,
     "    cachedTokens: cachedPrefixTokens(result.usage),"),
    ("arming: no size is measured, so no heartbeat ever counts",
     P,
     ARMED_SIZE + "\n",
     ""),
    ("arming: the size never reaches the armed prefix",
     L,
     "    ...(keepalive.cachedTokens === undefined ? {} : { keepalive_cached_tokens: keepalive.cachedTokens }),\n",
     ""),
    ("ping: the armed size goes out on the wire",
     K,
     "    keepalive_cached_tokens: _cached,\n",
     ""),

    # --- the restart -----------------------------------------------------------
    ("schedule: the push leaves the persisted warm time behind, so a restart drops a warm schedule",
     S,
     "    this.#prefixWarmAt = now;\n    this.#lastWarmAt = now;\n    this.#nextPingAt = this.#deadline(now);",
     "    this.#prefixWarmAt = now;\n    this.#nextPingAt = this.#deadline(now);"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
