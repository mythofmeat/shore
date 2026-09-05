#!/usr/bin/env python3
"""Mutation checks for the shared generation boundary.

Exercise model placement, credentials, replay safety, budgets and stream
accounting through the same runner used by chat and background workflows.
"""
import sys

TESTS = ["tests/llm_generate.test.ts", "tests/ledger_record.test.ts"]

MUTANTS = [
    (
        "placement: the sdk is ignored",
        "src/llm/generate.ts",
        "    if (model.sdk !== request.sdk) continue;",
        "    void request.sdk;",
    ),
    (
        "placement: the provider is ignored",
        "src/llm/generate.ts",
        "    if (request.provider_key !== undefined && request.provider_key !== model.providerKey) continue;",
        "    void model.providerKey;",
    ),
    (
        "placement: a request naming no provider matches nothing",
        "src/llm/generate.ts",
        "    if (request.provider_key !== undefined && request.provider_key !== model.providerKey) continue;",
        "    if (request.provider_key !== model.providerKey) continue;",
    ),
    (
        "placement: an uncatalogued model loses its request key",
        "src/llm/generate.ts",
        "      useRequestKey: resolved === undefined && request.api_key !== \"\",",
        "      useRequestKey: false,",
    ),
    (
        "rotation: configured provider keys are ignored",
        "src/llm/generate.ts",
        "          entry === undefined ? undefined : credentialEntry(entry),",
        "          undefined,",
    ),
    (
        "rotation: credential errors retry on the same key",
        "src/llm/generate.ts",
        "          shouldRetryError(error, attemptIndex, { max_retries: maxRetries }).decision === \"retry\",",
        "          attemptIndex < maxRetries,",
    ),
    (
        "rotation: the key is never applied",
        "src/llm/generate.ts",
        "    request.api_key = apiKey;",
        "    void apiKey;",
    ),
    (
        "rotation: ledger attribution loses the key",
        "src/llm/generate.ts",
        "      context: { ...required(request.context), api_key_name: name },",
        "      context: { ...required(request.context), api_key_name: \"\" },",
    ),
    (
        "rotation: fallback events are dropped",
        "src/llm/generate.ts",
        "record: (event) => { fallbacks.push(event); options.onFallback?.(event); }",
        "record: () => {}",
    ),
    (
        "rotation: no enabled keys bypasses credential policy",
        "src/llm/generate.ts",
        "  const result = await streamWithCredentialFallback(",
        "  if (candidates.length === 0) return { result: await attempt(request.api_key, 'ambient'), fallbacks };\n  const result = await streamWithCredentialFallback(",
    ),
    (
        "authentication: subscription calls require environment keys",
        "src/llm/generate.ts",
        "  const candidates = isKeylessSdk(request.sdk)",
        "  const candidates = false",
    ),
    (
        "call: unknown sdk picks the first adapter",
        "src/llm/generate.ts",
        "  const provider = deps.providers[request.sdk];",
        "  const provider = deps.providers[request.sdk] ?? Object.values(deps.providers)[0];",
    ),
    (
        "call: the budget gate is skipped",
        "src/llm/generate.ts",
        "    if (blocked) throw BudgetBlocked.from(blocked);",
        "    void blocked;",
    ),
    (
        "call: recording is bypassed",
        "src/llm/generate.ts",
        "      recordingStream(call.context, call, events, started, (nextRequest, callType) => {",
        "      recordingStream(undefined, call, events, started, (nextRequest, callType) => {",
    ),
    (
        "call: recording loses the original attempt",
        "src/llm/generate.ts",
        "      recordingStream(call.context, call, events, started, (nextRequest, callType) => {",
        "      recordingStream(call.context, call, events, undefined, (nextRequest, callType) => {",
    ),
    (
        "call: thrown failures are recorded as cancellations",
        "src/ledger/record.ts",
        "finish_reason: isAbortError(error) ? \"cancelled\" : \"error\",",
        "finish_reason: \"cancelled\",",
    ),
    (
        "call: stream failure is swallowed",
        "src/llm/generate.ts",
        "    if (\"err\" in outcome) throw outcome.err;",
        "    if (\"err\" in outcome) return { content: \"\", content_blocks: [], model: call.model, finish_reason: \"end_turn\", tool_uses: [], usage: {}, timing: {} } as never;",
    ),
    (
        "replay: tool-use events do not prevent fallback",
        "src/llm/generate.ts",
        "        if (event.type === \"tool_use\") replaySafe = false;",
        "        void event;",
    ),
    (
        "replay: visible output permits fallback",
        "src/llm/generate.ts",
        "    options.sink?.(message);",
        "    replaySafe = true;\n    options.sink?.(message);",
    ),
    ("cancellation: an aborted request can reach the provider", [
        ("  if (options.signal?.aborted) throw new AbortError();\n  ensureCallContext(request, deps);",
         "  ensureCallContext(request, deps);"),
        ("    if (options.signal?.aborted) throw new AbortError();\n    request.api_key = apiKey;",
         "    request.api_key = apiKey;"),
    ]),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS, src="src/llm/generate.ts")


if __name__ == "__main__":
    sys.exit(main())
