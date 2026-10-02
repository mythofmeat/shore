#!/usr/bin/env python3
"""Mutation pass over a heartbeat's refresh of the chat keepalive (#251).

A same-model heartbeat sends the chat's tools, system prompt and messages, with
its own prompt in a transient tail after the last cache breakpoint, so its first
round reads the entry the keepalive pings, and that read renews the entry's TTL.
The keepalive is told, and moves its next ping a full interval out. Otherwise
the ping goes out on the old schedule and pays to read an entry the heartbeat
refreshed minutes before.

Every mutant below still looks like a working keepalive. Four groups.

**Too eager.** A heartbeat that did not read the entry moves the ping anyway,
and the entry expires behind a ping that now comes too late. That covers later
rounds of the heartbeat's own tool loop, which read its own entries, a read
that stopped at the system prompt, another model, provider or thread, and
claude_agent, whose usage sums every request of a CLI session kept apart from
chat. A prefix rebuilt from disk was never measured, so nothing covers it.

**Too generous.** The refresh is booked as activity, which is #222 over again.
It moves `lastActiveAt` and so the idle ceiling, it gives the ping count back,
or its fingerprint is recorded and every later ping skips as stale. Or it
revives a schedule that a cold ping stopped.

**Mismeasured.** The armed size is what the turn's last call left cached: its
read plus its write, which is exactly what the first ping reads. The turn's
usage summed over its rounds is far larger once it ran a tool, so no heartbeat
would ever cover it. The read alone is smaller, so a heartbeat that stopped
short of the turn's new tail would count.

**Lost on restart.** The persisted schedule must carry the refresh. Restoring
refuses a schedule whose last warm is an interval old, so a restart past the
old deadline would drop one that is still warm.

A mutant is KILLED if `bun test` over TESTS fails with it applied.

This is **19/19** on the first pass.

Run from the repository root:
    python3 daemon/scripts/mutate_keepalive_heartbeat.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
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

# (label, file, find, replace)
MUTANTS = [
    # --- the signal ------------------------------------------------------------
    ("observe: a heartbeat is ignored again, so its refresh never moves the ping",
     K,
     "      this.#observeHeartbeat(character, usage, identity);\n      return;",
     "      return;"),
    ("observe: a heartbeat is recorded like a real call, the #222 regression",
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
