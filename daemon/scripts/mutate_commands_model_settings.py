#!/usr/bin/env python3
"""Mutation pass over the model-settings write boundary (#18 / #12).

#12 requires every parity fixture be mutation-checked. This surface fails
silently in the allowing direction in two distinct ways:

- **A parser that accepts too much** writes a setting the wire will not honor.
  Nothing errors; the user sets `temperature` on a model that rejects it and the
  value simply never has an effect, which looks exactly like the model ignoring
  them.
- **A capability check that is too permissive** persists a value into the
  preferences file that the *next config load* rejects — so the failure surfaces
  as a daemon that will not start, one restart after the setting that caused it.

Mutants target `src/commands/model_settings.ts` and the two functions the port
added to `src/llm/capabilities.ts`; each entry names its file. A mutant is
KILLED if `bun test tests/model_settings.test.ts` fails with it applied.

The first pass was 57/62 and the second is 61/61 — every mutant killed, which is
a first for this series. Three of the five first-pass survivors were mis-indented
patterns that never applied, not gaps. The other two were real, and only one was
a hole in the fixture:

- **No model id carried a `[[model_override]]` reasoning domain.** The six ids
  moved the Claude sampler cutoff and the `rejects_sampling` overrides, but every
  one of them fell through to its sdk's default effort set — so
  `reasoningDomain(sdk, modelId)` and `reasoningDomain(sdk)` agreed on all
  forty-two rows, and dropping the model id changed nothing. Four ids now hit an
  effort override: `gemini-3.1-pro`, `google/gemini-2.5-flash`, `x-ai/grok-4`,
  and `google/gemini-3.1-pro` — that last one matches two overrides at once and
  pins that the first listed wins.
- **The other survivor was a true equivalence, and it removed code.** The Rust
  wrote error values two ways, `{value}` (`Display`) and `{s:?}` (`Debug`), which
  differ for everything except a string. Both `{s:?}` sites are reached only with
  a string already in hand, so the two spellings cannot be told apart here. The
  port had carried both helpers; it now has one.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_model_settings.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SETTINGS = "src/commands/model_settings.ts"
CAPS = "src/llm/capabilities.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- the shared primitive parsers --------------------------------------
    ("number: a numeric string is accepted", SETTINGS,
     '  typeof v === "number" ? { value: v } : { error: `${name} must be a number, got ${show(v)}` };',
     '  typeof v === "number" || typeof v === "string"\n'
     "    ? { value: Number(v) }\n"
     "    : { error: `${name} must be a number, got ${show(v)}` };"),
    ("string: a number is coerced", SETTINGS,
     '  typeof v === "string" ? { value: v } : { error: `${name} must be a string, got ${show(v)}` };',
     '  v === null || v === undefined\n'
     "    ? { error: `${name} must be a string, got ${show(v)}` }\n"
     "    : { value: String(v) };"),
    ("boolean: a truthy value is accepted", SETTINGS,
     '  typeof v === "boolean" ? { value: v } : { error: `${name} must be a boolean, got ${show(v)}` };',
     "  { value: Boolean(v) };"),
    ("u32: a fraction is accepted", SETTINGS,
     '  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xff_ff_ff_ff',
     '  typeof v === "number" && v >= 0 && v <= 0xff_ff_ff_ff'),
    ("u32: a negative is accepted", SETTINGS,
     '  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xff_ff_ff_ff',
     '  typeof v === "number" && Number.isInteger(v) && v <= 0xff_ff_ff_ff'),
    ("u32: the ceiling is off by one", SETTINGS,
     "&& v >= 0 && v <= 0xff_ff_ff_ff",
     "&& v >= 0 && v < 0xff_ff_ff_ff"),
    ("u32: no ceiling at all", SETTINGS,
     "&& v >= 0 && v <= 0xff_ff_ff_ff",
     "&& v >= 0"),

    # --- per-key parser wiring ---------------------------------------------
    ("wiring: temperature and top_p report each other's name", SETTINGS,
     '  temperature: number("temperature"),\n  top_p: number("top_p"),',
     '  temperature: number("top_p"),\n  top_p: number("temperature"),'),
    ("wiring: budget_tokens takes any number", SETTINGS,
     '  budget_tokens: u32("budget_tokens"),',
     '  budget_tokens: number("budget_tokens"),'),
    ("wiring: reasoning_effort takes any value", SETTINGS,
     '  reasoning_effort: string("reasoning_effort"),',
     "  reasoning_effort: (v) => ({ value: v }),"),
    ("wiring: cache_ttl is parsed like cache_keepalive", SETTINGS,
     '  cache_ttl: string("cache_ttl"),',
     "  cache_ttl: (v) => {\n"
     '    const raw = string("cache_ttl")(v);\n'
     '    if ("error" in raw) return raw;\n'
     "    const parsed = parseCacheKeepalive(raw.value as string);\n"
     '    return "err" in parsed ? { error: `cache_ttl: ${parsed.err}` } : { value: raw.value };\n'
     "  },"),
    ("wiring: gemini_generation is a boolean", SETTINGS,
     '  gemini_generation: u32("gemini_generation"),',
     '  gemini_generation: boolean("gemini_generation"),'),
    ("wiring: the two zai knobs are swapped", SETTINGS,
     '  zai_clear_thinking: boolean("zai_clear_thinking"),\n  zai_subscription: boolean("zai_subscription"),',
     '  zai_clear_thinking: boolean("zai_subscription"),\n  zai_subscription: boolean("zai_clear_thinking"),'),

    # --- cache_keepalive ----------------------------------------------------
    ("keepalive: a parse failure is swallowed", SETTINGS,
     '    return "err" in parsed ? { error: `cache_keepalive: ${parsed.err}` } : { value: parsed.ok };',
     '    return "err" in parsed ? { value: { kind: "off" } } : { value: parsed.ok };'),
    ("keepalive: the error loses its prefix", SETTINGS,
     '{ error: `cache_keepalive: ${parsed.err}` }',
     "{ error: parsed.err }"),

    # --- sdk ----------------------------------------------------------------
    ("sdk: any string is stored", SETTINGS,
     "    return sdkFromWire(s) === undefined\n"
     "      ? { error: `sdk must be one of ${SDK_VARIANTS.map(show).join(\", \")}; got ${show(s)}` }\n"
     "      : { value: s };",
     "    return { value: s };"),
    ("sdk: the canonical form is stored, not what the user typed", SETTINGS,
     "      : { value: s };\n  },\n\n  replay_prior_thinking:",
     "      : { value: sdkFromWire(s) };\n  },\n\n  replay_prior_thinking:"),
    ("sdk: the rejection message is unquoted", SETTINGS,
     "got ${show(s)}` }",
     "got ${s}` }"),

    # --- replay_prior_thinking ----------------------------------------------
    ("replay: the legacy bool is inverted", SETTINGS,
     '    if (typeof v === "boolean") return { value: v ? "all" : "none" };',
     '    if (typeof v === "boolean") return { value: v ? "none" : "all" };'),
    ("replay: the legacy bool is rejected", SETTINGS,
     '    if (typeof v === "boolean") return { value: v ? "all" : "none" };',
     "    if (false as boolean) return { value: undefined };"),
    ("replay: an unknown string is accepted verbatim", SETTINGS,
     "    return parsed === undefined\n"
     '      ? { error: `replay_prior_thinking must be "all" or "none"; got ${show(v)}` }\n'
     "      : { value: parsed };",
     "    return { value: parsed ?? v };"),

    # --- max_tool_iterations -------------------------------------------------
    ("max_tool_iterations: zero is accepted", SETTINGS,
     "    return parsed.value === 0\n"
     '      ? { error: "max_tool_iterations must be >= 1; unset it (null) for unlimited" }\n'
     "      : parsed;",
     "    return parsed;"),
    ("max_tool_iterations: one is rejected too", SETTINGS,
     "    return parsed.value === 0",
     "    return (parsed.value as number) <= 1"),

    # --- openrouter_provider -------------------------------------------------
    ("routing: an array counts as an object", SETTINGS,
     '    if (typeof v !== "object" || v === null || Array.isArray(v)) {',
     '    if (typeof v !== "object" || v === null) {'),
    ("routing: a scalar is stored verbatim", SETTINGS,
     '    if (typeof v !== "object" || v === null || Array.isArray(v)) {\n'
     "      return { error: `openrouter_provider must be a routing object, got ${show(v)}` };\n"
     "    }",
     "    if (false as boolean) {\n"
     "      return { error: `openrouter_provider must be a routing object, got ${show(v)}` };\n"
     "    }"),
    ("routing: TOML representability is not checked", SETTINGS,
     "    const bad = tomlUnrepresentable(v);",
     "    const bad = undefined as string | undefined;"),
    ("routing: only the top level is checked for nulls", SETTINGS,
     "  if (typeof value === \"object\") {\n"
     "    for (const item of Object.values(value)) {\n"
     "      const bad = tomlUnrepresentable(item);\n"
     "      if (bad !== undefined) return bad;\n"
     "    }\n"
     "  }",
     "  if (typeof value === \"object\") {\n"
     "    for (const item of Object.values(value)) {\n"
     "      if (item === null) return \"unsupported unit type\";\n"
     "    }\n"
     "  }"),
    ("routing: nulls inside arrays are allowed", SETTINGS,
     "  if (Array.isArray(value)) {\n"
     "    for (const item of value) {\n"
     "      const bad = tomlUnrepresentable(item);\n"
     "      if (bad !== undefined) return bad;\n"
     "    }\n"
     "    return undefined;\n"
     "  }",
     "  if (Array.isArray(value)) return undefined;"),

    # --- applySamplerValue itself --------------------------------------------
    ("apply: an unknown key is silently ignored", SETTINGS,
     "  if (field === undefined || parser === undefined) {\n"
     "    throw invalidRequest(`unknown setting key: ${key}`);\n"
     "  }",
     "  if (field === undefined || parser === undefined) return;"),
    ("apply: null does not clear", SETTINGS,
     "  if (value === null || value === undefined) {\n"
     "    target[field] = undefined;\n"
     "    return;\n"
     "  }",
     "  if (false as boolean) {\n"
     "    target[field] = undefined;\n"
     "    return;\n"
     "  }"),
    ("apply: null clears every field, not just this one", SETTINGS,
     "    target[field] = undefined;\n    return;",
     "    for (const f of SAMPLER_FIELD_BY_KEY.values()) target[f] = undefined;\n    return;"),
    ("apply: the value is written before it is parsed", SETTINGS,
     "  const parsed = parser(value);\n"
     '  if ("error" in parsed) throw invalidRequest(parsed.error);\n'
     "  target[field] = parsed.value;",
     "  target[field] = value;\n"
     "  const parsed = parser(value);\n"
     '  if ("error" in parsed) throw invalidRequest(parsed.error);\n'
     "  target[field] = parsed.value;"),
    ("apply: the parsed value is discarded and the raw one stored", SETTINGS,
     "  target[field] = parsed.value;",
     "  target[field] = value;"),

    # --- capabilityCheck ------------------------------------------------------
    ("check: clearing is validated too", SETTINGS,
     "  if (value === null || value === undefined) return undefined;\n"
     "  const field = fieldFromKey(key);",
     "  const field = fieldFromKey(key);"),
    ("check: a key outside the matrix is rejected", SETTINGS,
     "  if (field === undefined) return undefined;",
     "  if (field === undefined) return invalidRequest(`unknown field: ${key}`);"),
    ("check: the off sentinel is never special-cased", SETTINGS,
     "  const reasoningOff =\n"
     '    field === "reasoning_effort" && value === "off" && supportsReasoningOff(sdk);',
     "  const reasoningOff = false as boolean;"),
    ("check: the off sentinel is honored on every sdk", SETTINGS,
     '    field === "reasoning_effort" && value === "off" && supportsReasoningOff(sdk);',
     '    field === "reasoning_effort" && value === "off";'),
    ("check: the off sentinel escapes the domain check for any field", SETTINGS,
     '    field === "reasoning_effort" && value === "off" && supportsReasoningOff(sdk);',
     '    value === "off" && supportsReasoningOff(sdk);'),
    ("check: every value probes as a string", SETTINGS,
     '  const probe: string | true = typeof value === "string" && !reasoningOff ? value : true;',
     '  const probe: string | true = typeof value === "string" ? value : true;'),
    ("check: every value probes as a non-string", SETTINGS,
     '  const probe: string | true = typeof value === "string" && !reasoningOff ? value : true;',
     "  const probe: string | true = true;"),
    ("check: the failure is dropped", SETTINGS,
     "  return failure === undefined ? undefined : invalidRequest(failure.message);",
     "  return undefined;"),

    # --- keyApplicability -----------------------------------------------------
    ("table: matrix-less keys report honored rather than always", SETTINGS,
     '    out[key] = field === undefined ? "always" : applicability(sdk, field, capabilities);',
     '    out[key] = field === undefined ? "honored" : applicability(sdk, field, capabilities);'),
    ("table: the model's capabilities are ignored", SETTINGS,
     '    out[key] = field === undefined ? "always" : applicability(sdk, field, capabilities);',
     '    out[key] = field === undefined ? "always" : applicability(sdk, field, undefined);'),
    ("table: every key is reported as always", SETTINGS,
     '    out[key] = field === undefined ? "always" : applicability(sdk, field, capabilities);',
     '    out[key] = "always";'),

    # --- capabilities.ts: supportsReasoningOff --------------------------------
    ("off-switch: every sdk honors it", CAPS,
     '  return sdk !== "gemini";',
     "  return true as boolean;"),
    ("off-switch: only gemini honors it", CAPS,
     '  return sdk !== "gemini";',
     '  return sdk === "gemini";'),
    ("off-switch: nobody honors it", CAPS,
     '  return sdk !== "gemini";',
     "  return false as boolean;"),

    # --- capabilities.ts: validate --------------------------------------------
    ("validate: an ignored field is settable", CAPS,
     '  if (applicability(sdk, field, caps) !== "honored") {',
     '  if (applicability(sdk, field, caps) === "rejected") {'),
    ("validate: a rejected field is settable", CAPS,
     '  if (applicability(sdk, field, caps) !== "honored") {',
     '  if (applicability(sdk, field, caps) === "ignored") {'),
    ("validate: applicability is never checked", CAPS,
     '  if (applicability(sdk, field, caps) !== "honored") {',
     "  if (false as boolean) {"),
    ("validate: the effort domain is not checked", CAPS,
     '  if (field === "reasoning_effort" && probe !== true) {',
     "  if (false as boolean) {"),
    ("validate: the effort domain ignores the model's capabilities", CAPS,
     "    const domain = reasoningDomain(sdk, caps);",
     "    const domain = reasoningDomain(sdk, undefined);"),
    ("validate: a non-string effort is domain-checked too", CAPS,
     '  if (field === "reasoning_effort" && probe !== true) {',
     '  if (field === "reasoning_effort") {'),
    ("validate: the keepalive domain is not checked", CAPS,
     '  if (field === "cache_keepalive") {',
     "  if (false as boolean) {"),
    ("validate: a non-string keepalive is accepted", CAPS,
     '    const allowed = "off, or a duration string like 55m / 6h / 30s";\n'
     '    if (probe === true) return outOfDomain("true", allowed);',
     '    const allowed = "off, or a duration string like 55m / 6h / 30s";\n'
     "    if (probe === true) return undefined;"),
    ("validate: a non-string keepalive reports the wrong value", CAPS,
     '    const allowed = "off, or a duration string like 55m / 6h / 30s";\n'
     '    if (probe === true) return outOfDomain("true", allowed);',
     '    const allowed = "off, or a duration string like 55m / 6h / 30s";\n'
     '    if (probe === true) return outOfDomain("<non-string>", allowed);'),
    ("validate: a non-string idle ceiling is accepted", CAPS,
     '    const allowed = "a duration string like 90m / 12h";\n'
     '    if (probe === true) return outOfDomain("true", allowed);',
     '    const allowed = "a duration string like 90m / 12h";\n'
     "    if (probe === true) return undefined;"),
    ("validate: an unparseable idle ceiling is accepted", CAPS,
     '    if ("err" in parseCacheKeepaliveMax(probe)) return outOfDomain(probe, allowed);',
     "    void parseCacheKeepaliveMax;"),
    ("validate: the idle ceiling accepts off, which stops nothing", CAPS,
     '    if ("err" in parseCacheKeepaliveMax(probe)) return outOfDomain(probe, allowed);',
     '    if ("err" in parseCacheKeepalive(probe)) return outOfDomain(probe, allowed);'),
    ("validate: an unparseable keepalive is accepted", CAPS,
     '    if ("err" in parseCacheKeepalive(probe)) return outOfDomain(probe, allowed);',
     "    void parseCacheKeepalive;"),
    ("validate: the out-of-domain value is unquoted", CAPS,
     "    new CapabilityError(`\\`${field}\\` value ${JSON.stringify(value)} is out of domain; allowed: ${allowed}`);",
     "    new CapabilityError(`\\`${field}\\` value ${value} is out of domain; allowed: ${allowed}`);"),
    ("validate: the allowed list is joined without spaces", CAPS,
     '    if (!domain.includes(probe)) return outOfDomain(probe, domain.join(", "));',
     '    if (!domain.includes(probe)) return outOfDomain(probe, domain.join(","));'),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(
        MUTANTS,
        ["tests/model_settings.test.ts", "tests/capabilities.test.ts"],
    )


if __name__ == "__main__":
    sys.exit(main())
