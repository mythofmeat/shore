#!/usr/bin/env python3
"""Mutation pass over the non-streaming generate seam (#18, step 5).

This is the seam three background passes were built against and none of them
could exercise — each carried an injected stub with a note saying the real one
lands with the wiring. So nothing here has ever run in anger, and the mutants
are chosen for the failures a stub could never have surfaced.

Two groups.

**Rotation.** The layering is retry inside, rotate outside, and the two must not
swap: a credential-shaped failure fails fast *so that* the rotation happens
without burning a backoff first, and a failure no other key can fix must not
rotate at all — rotating on a 400 spends every credential the user has on a
request that was malformed to begin with. The events come back to the caller
rather than being logged here, because a heartbeat folds them into its ring
buffer and a chat turn sends them to the client, and neither is this module's
call to make.

**Placement and recording.** A request the static catalog cannot place still
runs on the key it was built with. Discovered models and `provider:model_id`
pins are never in that catalog, so refusing them would take out exactly the
configurations the effective catalog exists to support. And the ledger row is
written whether or not the call worked — a ledger with holes in it reads as a
quiet period rather than as a provider that is down.

A mutant is KILLED if `bun test tests/llm_generate.test.ts` fails with it
applied.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_llm_generate.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
G = "src/llm/generate.ts"

TESTS = ["tests/llm_generate.test.ts"]

ATTEMPT = (
    "      streamWithRetry(\n"
    "        () => {\n"
    "          request.api_key = apiKey;\n"
    "          if (request.context !== undefined) request.context.api_key_name = candidate.name;\n"
    "          return callProvider(request, deps, signal);\n"
    "        },\n"
    "        deps.retry ?? DEFAULT_RETRY,\n"
    "        undefined,\n"
    "        deps.sleep,\n"
    "      ),"
)

# (label, file, find, replace)
MUTANTS = [
    # --- placing the request --------------------------------------------------
    ("placement: the sdk is ignored, so a same-id model on another sdk matches",
     G, "    if (model.sdk !== request.sdk) continue;", "    void request.sdk;"),
    ("placement: the provider is ignored, so a pin matches the wrong provider's keys",
     G,
     "    if (request.provider_key !== undefined && request.provider_key !== model.providerKey) continue;",
     "    void model.providerKey;"),
    ("placement: a request naming no provider matches nothing",
     G,
     "    if (request.provider_key !== undefined && request.provider_key !== model.providerKey) continue;",
     "    if (request.provider_key !== model.providerKey) continue;"),
    ("placement: a model the catalog cannot place is refused instead of run",
     G,
     "  console.debug(\n"
     "    `shore: ${request.provider_key ?? request.sdk}/${request.model} is not in the static catalog; ` +\n"
     "      `calling with the request's own key`,\n"
     "  );\n"
     "  return { response: await callProvider(request, deps, signal), fallbacks: [] };",
     "  throw new Error(`unknown model: ${request.model}`);"),

    # --- rotation -------------------------------------------------------------
    ("rotation: only the model's own env var is consulted, so `[providers].keys` is ignored",
     G,
     "  const entry = deps.config.providers.get(resolved.providerKey);\n"
     "  const candidates = resolveKeyCandidates(\n"
     "    resolved.providerKey,\n"
     "    entry === undefined ? undefined : credentialEntry(entry),\n"
     "    resolved.apiKeyEnv,\n"
     "  );",
     "  const candidates = resolveKeyCandidates(resolved.providerKey, undefined, resolved.apiKeyEnv);"),
    ("rotation: a credential failure is retried on the same key instead of rotating",
     G, ATTEMPT,
     "      streamWithRetry(\n"
     "        () => {\n"
     "          request.api_key = apiKey;\n"
     "          if (request.context !== undefined) request.context.api_key_name = candidate.name;\n"
     "          return callProvider(request, deps, signal);\n"
     "        },\n"
     "        deps.retry ?? DEFAULT_RETRY,\n"
     "        (_e, attempt, max) => attempt < max,\n"
     "        deps.sleep,\n"
     "      ),"),
    ("rotation: the key is never applied, so every attempt runs on the seed credential",
     G,
     "          request.api_key = apiKey;",
     "          void apiKey;"),
    ("rotation: the ledger row is attributed to no key",
     G,
     "          if (request.context !== undefined) request.context.api_key_name = candidate.name;",
     "          void candidate;"),
    ("rotation: the events are dropped, so nothing ever reports a rotation",
     G,
     "    { record: (event) => fallbacks.push(event) },",
     "    { record: () => {} },"),
    ("rotation: a provider with no enabled keys falls through to an ambient lookup",
     G,
     "  const fallbacks: FallbackEvent[] = [];\n"
     "  const response = await streamWithCredentialFallback(",
     "  const fallbacks: FallbackEvent[] = [];\n"
     "  if (candidates.length === 0) {\n"
     "    return { response: await callProvider(request, deps, signal), fallbacks };\n"
     "  }\n"
     "  const response = await streamWithCredentialFallback("),

    # --- the call itself ------------------------------------------------------
    ("call: an unknown sdk silently picks whichever adapter is first",
     G,
     "  const provider = deps.providers[request.sdk];\n"
     "  if (provider === undefined) throw new Error(`unsupported sdk: ${request.sdk}`);",
     "  const provider = deps.providers[request.sdk] ?? Object.values(deps.providers)[0]!;"),
    ("call: the budget gate is skipped",
     G,
     "  const blocked = budgetBlockFor(request);\n"
     "  if (blocked) throw new BudgetBlocked(blocked.message, blocked.scope);",
     "  void request;"),
    ("call: a successful call is not recorded",
     G,
     "    recordGenerate(request.context, request, response);",
     "    void response;"),
    ("call: a failed call leaves no row, so the ledger reads as a quiet period",
     G,
     "    recordGenerateError(request.context, request, startedAt, clock);\n"
     "    throw e;",
     "    void startedAt;\n"
     "    throw e;"),
    ("call: a failure is swallowed and reported as an empty response",
     G,
     "    recordGenerateError(request.context, request, startedAt, clock);\n"
     "    throw e;",
     "    recordGenerateError(request.context, request, startedAt, clock);\n"
     "    return { content: '', content_blocks: [], finish_reason: 'error',\n"
     "      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },\n"
     "      timing: { total_ms: 0, time_to_first_token_ms: 0 }, model: request.model };"),
]


def run_tests() -> bool:
    """True when the suite passes."""
    proc = subprocess.run(
        ["bun", "test", *TESTS],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def main() -> int:
    if not run_tests():
        print("baseline is red — fix the suite before mutating", file=sys.stderr)
        return 2

    survivors = []
    for i, (label, rel, find, replace) in enumerate(MUTANTS, start=1):
        path = ROOT / rel
        original = path.read_text()
        if find not in original:
            print(f"{i:3}. ERROR mutant does not apply: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        if original.count(find) != 1:
            print(f"{i:3}. ERROR mutant is ambiguous: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        path.write_text(original.replace(find, replace))
        try:
            killed = not run_tests()
        finally:
            path.write_text(original)
        print(f"{i:3}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append(label)

    print(f"\n{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} killed")
    for label in survivors:
        print(f"  SURVIVOR: {label}")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
