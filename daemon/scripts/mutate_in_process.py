#!/usr/bin/env python3
"""Mutation pass over the in-process autonomy executor and the transcript it
writes (#18, step 5).

This class is supposed to hold no decisions — every action is already its own
module, and what is left is the wiring each one cannot assemble for itself. So
the mutants are aimed at the wiring, and they fall into the three places a piece
of wiring can be wrong without anything failing.

**What the ledger is told.** The call type is per round: the first call is the
tick, the rest are its loop, and that is how a heartbeat's own cost is told from
its tool rounds'. Collapse them and the distinction is gone from every row.

**Which action runs.** `max_turns` compaction fires inline from the turn that
crossed the threshold, under that turn's config. Running it here as well
compacts the same conversation twice and bills for both. And the deep archive's
covered-turn count picks between a free file archive and a paid model call, so a
wrong number there is a bill rather than a bug.

**What the model is told back.** `set_next_wake` is clamped by the clock, and the
answer quotes the clamped number — a character told it got the 900 hours it
asked for plans around a wake that will never come.

The transcript mutants are the other half: an entry a person reads afterwards,
where an empty reasoning list and a redacted-thinking placeholder mean different
things, and where a failed write must never take a tick down with it.

A mutant is KILLED if `bun test tests/autonomy_in_process.test.ts
tests/transcript_capture.test.ts` fails with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_in_process.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
P = "src/autonomy/in_process.ts"
T = "src/transcript_capture.ts"

TESTS = ["tests/autonomy_in_process.test.ts", "tests/transcript_capture.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- what the ledger is told ----------------------------------------------
    ("ledger: every round is labelled a heartbeat, so the loop's cost is misattributed",
     P,
     "    call_type: callType,",
     '    call_type: "heartbeat",'),
    ("ledger: the character is dropped, so rows cannot be attributed",
     P,
     "    character,\n    call_type: callType,",
     "    call_type: callType,"),
    ("ledger: the existing context is discarded, taking the ledger path with it",
     P,
     "  request.context = {\n    ...request.context,\n    ledger: request.context?.ledger ?? rustJoin(config.dirs.data, \"ledger.db\"),",
     '  request.context = {\n    ledger: rustJoin(config.dirs.data, "ledger.db"),'),

    # --- which action runs ----------------------------------------------------
    ("action: a max_turns compaction runs here too, compacting the same turns twice",
     P,
     '    if (reason !== "idle") {',
     "    if (false as boolean) {"),
    ("action: the idle compaction is refused along with max_turns",
     P,
     '    if (reason !== "idle") {',
     "    if (true as boolean) {"),
    ("action: the deep archive always takes the paid arm",
     P,
     "    }, coveredTurnCount);",
     "    }, 0);"),
    ("action: the deep archive always takes the free arm",
     P,
     "    }, coveredTurnCount);",
     "    }, Number.MAX_SAFE_INTEGER);"),

    # --- what the model is told back ------------------------------------------
    ("wake: the model is told the hours it asked for, not the hours it got",
     P,
     "        const used = hooks.scheduleNextWake(hours, reason);\n"
     "        return `Scheduled next moment in ${used.toFixed(1)} hours.`;",
     "        hooks.scheduleNextWake(hours, reason);\n"
     "        return `Scheduled next moment in ${hours.toFixed(1)} hours.`;"),
    ("wake: the clock is never moved, so the character schedules nothing",
     P,
     "        const used = hooks.scheduleNextWake(hours, reason);",
     "        const used = hours;"),
    ("wake: the reason is dropped from the log line the clock writes",
     P,
     "        const used = hooks.scheduleNextWake(hours, reason);",
     '        const used = hooks.scheduleNextWake(hours, "");'),

    # --- which toggle a notification obeys ------------------------------------
    ("notify: the deep archive announces itself as an autonomous message",
     P,
     "        : { notify: this.#deps.notifyCompactionComplete }),",
     "        : { notify: this.#deps.notifyAutonomousMessage }),"),
    ("notify: the deep archive announces nothing at all",
     P,
     "        ...(this.#deps.notifyCompactionComplete === undefined\n"
     "          ? {}\n"
     "          : { notify: this.#deps.notifyCompactionComplete }),",
     "        ...({} as Record<string, never>),"),

    # --- the tool surface -----------------------------------------------------
    ("tools: a tool failure is reported to the model as a success",
     P,
     "          isError: run.isError,",
     "          isError: false,"),
    ("tools: heartbeat tools skip the shared policy and go straight to dispatch",
     P,
     "        const run = await runToolUse(",
     "        const run = await runToolUseWithoutPolicy("),
    ("tools: the per-tool deadline and result window are not applied",
     P,
     "          limits: toolLimitsFrom(config.app.tools, config.app.subagents),",
     "          limits: { max_result_chars: Number.MAX_SAFE_INTEGER, timeout_ms: 0 },"),
    ("tools: the model's declared schemas are not enforced",
     P,
     "          schemas: schemasFrom(tools),",
     "          schemas: undefined,"),
    ("tools: a generated image is never seen, because the value is not returned",
     P,
     "          ...(run.value === undefined ? {} : { value: run.value }),",
     ""),
    ("tools: the executed block is dropped, losing attached media",
     P,
     "          block: run.block,",
     ""),

    # --- the transcript -------------------------------------------------------
    ("transcript: redacted thinking vanishes instead of leaving a placeholder",
     T,
     '      reasoning.push("[redacted thinking]");',
     "      void block;"),
    ("transcript: blank thinking is recorded as a reasoning step",
     T,
     '      if (block.thinking.trim() !== "") reasoning.push(block.thinking);',
     "      reasoning.push(block.thinking);"),
    ("transcript: split text blocks are concatenated with no separator",
     T,
     '        if (text !== "") text += "\\n";',
     "        void text;"),
    ("transcript: an empty text block becomes a blank line",
     T,
     '      if (block.text !== "") {',
     "      if (true as boolean) {"),
    ("transcript: a tool's error flag is dropped",
     T,
     "      is_error: tool.isError,",
     "      is_error: false,"),
    ("transcript: an unreported model is stored as an empty name",
     T,
     '    model: params.response.model === "" ? null : params.response.model,',
     "    model: params.response.model,"),
    ("transcript: a failed write takes the tick down with it",
     T,
     "  } catch (e) {\n"
     "    shoreLog.warn(`shore: failed to record a ${params.source} transcript entry: ${String(e)}`);\n"
     "  }",
     "  } catch (e) {\n"
     "    throw e;\n"
     "  }"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
