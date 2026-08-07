/**
 * The write boundary for per-model settings: parsing the fourteen sampler keys,
 * and the capability check that guards them.
 *
 * Ported from the pure half of `crates/daemon/src/commands/state/models.rs`,
 * pinned by `tests/commands_fixtures/model_settings_parity.json`.
 *
 * # Two layers, and they reject different things
 *
 * {@link capabilityCheck} asks whether this *model* can do anything with the
 * key at all — a `gemini_generation` on an Anthropic model is refused here, and
 * so is a `reasoning_effort` value outside the sdk's graded domain. It runs
 * first, so nothing the wire would ignore reaches the preferences file.
 *
 * {@link applySamplerValue} then asks whether the value is well-typed for the
 * key, and writes it. `null` always clears, and clearing is never
 * capability-checked: there is no value to validate.
 *
 * # One list, not two
 *
 * The Rust declared `SAMPLER_KEYS` beside a fourteen-arm `match` that had to
 * agree with it, and the agreement was by hand. Here `config/preferences.ts`
 * already owns the key-to-field map, so the list, the parser table and the
 * settings type are the same fourteen entries by construction. A key that is
 * accepted but never stored is not expressible.
 */

import {
  SAMPLER_FIELD_BY_KEY,
  SAMPLER_KEYS,
  type SamplerSettings,
} from "../config/preferences.ts";
import { parseCacheKeepalive, sdkFromWire, type Sdk } from "../config/models.ts";
import { parseThinkingReplay } from "../config/app.ts";
import {
  applicability,
  fieldFromKey,
  reasoningDomain,
  supportsReasoningOff,
  validate,
  type Applicability,
} from "../llm/capabilities.ts";
import { invalidRequest, type CommandError } from "./errors.ts";

export { SAMPLER_KEYS };

/**
 * How a value renders inside an error message.
 *
 * The Rust used two spellings — `{value}` (serde's `Display`) and `{s:?}`
 * (`Debug`) — which differ for everything except a string. Both `{s:?}` sites
 * are reached only with a string already in hand, so the distinction collapses
 * here and one helper covers both.
 */
const show = (v: unknown): string => JSON.stringify(v) ?? "null";

// ── the fourteen parsers ──────────────────────────────────────────────────

/** Parsed value for the key, or the message explaining why it is not one. */
type Parsed = { value: unknown } | { error: string };

const number = (name: string) => (v: unknown): Parsed =>
  typeof v === "number" ? { value: v } : { error: `${name} must be a number, got ${show(v)}` };

const string = (name: string) => (v: unknown): Parsed =>
  typeof v === "string" ? { value: v } : { error: `${name} must be a string, got ${show(v)}` };

const boolean = (name: string) => (v: unknown): Parsed =>
  typeof v === "boolean" ? { value: v } : { error: `${name} must be a boolean, got ${show(v)}` };

/**
 * `as_u64` then `u32::try_from`: a negative number, a fraction and anything past
 * `u32::MAX` all fail, and they fail with one message rather than three.
 */
const u32 = (name: string) => (v: unknown): Parsed =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xff_ff_ff_ff
    ? { value: v }
    : { error: `${name} must be a non-negative integer fitting in u32, got ${show(v)}` };

const PARSERS: Record<string, (v: unknown) => Parsed> = {
  temperature: number("temperature"),
  top_p: number("top_p"),
  reasoning_effort: string("reasoning_effort"),
  budget_tokens: u32("budget_tokens"),
  max_output_tokens: u32("max_output_tokens"),
  cache_ttl: string("cache_ttl"),
  gemini_generation: u32("gemini_generation"),
  zai_clear_thinking: boolean("zai_clear_thinking"),
  zai_subscription: boolean("zai_subscription"),

  cache_keepalive: (v) => {
    const raw = string("cache_keepalive")(v);
    if ("error" in raw) return raw;
    const parsed = parseCacheKeepalive(raw.value as string);
    return "err" in parsed ? { error: `cache_keepalive: ${parsed.err}` } : { value: parsed.ok };
  },

  /**
   * Rejected up front so the preferences file never carries a value the
   * request-time overlay would have to discard.
   *
   * `moonshotai` is accepted — it is an alias the wire parser takes — and
   * stored verbatim, so the file can hold a spelling the settings command
   * itself never suggests. That is the Rust's behaviour: it validates with
   * `parse_wire` and then stores the user's original string.
   */
  sdk: (v) => {
    const raw = string("sdk")(v);
    if ("error" in raw) return raw;
    const s = raw.value as string;
    return sdkFromWire(s) === undefined
      ? { error: `sdk must be one of "anthropic", "openai", "gemini", "zai"; got ${show(s)}` }
      : { value: s };
  },

  replay_prior_thinking: (v) => {
    // The legacy bool spelling predates the two-mode string and still loads.
    if (typeof v === "boolean") return { value: v ? "all" : "none" };
    if (typeof v !== "string") {
      return { error: `replay_prior_thinking must be "all" or "none"; got ${show(v)}` };
    }
    const parsed = parseThinkingReplay(v);
    return parsed === undefined
      ? { error: `replay_prior_thinking must be "all" or "none"; got ${show(v)}` }
      : { value: parsed };
  },

  max_tool_iterations: (v) => {
    const parsed = u32("max_tool_iterations")(v);
    if ("error" in parsed) return parsed;
    // Unlimited is spelled by unsetting, so 0 would be an unreachable cap.
    return parsed.value === 0
      ? { error: "max_tool_iterations must be >= 1; unset it (null) for unlimited" }
      : parsed;
  },

  /**
   * Routing is an object (`{ order, allow_fallbacks, … }`); a scalar would be
   * stored verbatim and mean nothing on the wire.
   *
   * The Rust then converted to `toml::Value`, which fails on JSON that TOML
   * cannot hold — a `null` anywhere in the object, at any depth. Kept, because
   * the value goes on to be written into a TOML preferences file either way.
   */
  openrouter_provider: (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return { error: `openrouter_provider must be a routing object, got ${show(v)}` };
    }
    const bad = tomlUnrepresentable(v);
    return bad === undefined
      ? { value: v }
      : { error: `openrouter_provider must be a TOML-compatible object: ${bad}` };
  },
};

/** The message `toml::Value::try_from` fails with, or `undefined` if it would not. */
function tomlUnrepresentable(value: unknown): string | undefined {
  if (value === null) return "unsupported unit type";
  if (Array.isArray(value)) {
    for (const item of value) {
      const bad = tomlUnrepresentable(item);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const bad = tomlUnrepresentable(item);
      if (bad !== undefined) return bad;
    }
  }
  return undefined;
}

/**
 * Write one setting into `sampler`. `null` clears the field.
 *
 * Throws without touching `sampler` when the value is wrong for the key, so a
 * rejected write is never a partial one.
 */
export function applySamplerValue(sampler: SamplerSettings, key: string, value: unknown): void {
  const field = SAMPLER_FIELD_BY_KEY.get(key);
  const parser = PARSERS[key];
  if (field === undefined || parser === undefined) {
    throw invalidRequest(`unknown setting key: ${key}`);
  }

  const target = sampler as Record<string, unknown>;
  if (value === null || value === undefined) {
    target[field] = undefined;
    return;
  }

  const parsed = parser(value);
  if ("error" in parsed) throw invalidRequest(parsed.error);
  target[field] = parsed.value;
}

// ── the capability boundary ───────────────────────────────────────────────

/**
 * Refuse a setting the model's resolved sdk cannot honor, and a value outside
 * the domain it does honor.
 *
 * Clearing is always allowed — there is no value to validate — and keys outside
 * the matrix (`sdk`, `max_tool_iterations`, and anything unknown) pass through
 * to the parser, which is what rejects them.
 *
 * The `off` sentinel is not a wire value: the overlay suppresses reasoning
 * rather than sending it, so it is absent from the graded domains. On an sdk
 * whose adapter honors the off-switch it skips the domain check; on one without
 * a disable path it deliberately falls through and is rejected as out of
 * domain, because there it would silently do nothing.
 */
export function capabilityCheck(
  sdk: Sdk,
  modelId: string,
  key: string,
  value: unknown,
): CommandError | undefined {
  if (value === null || value === undefined) return undefined;
  const field = fieldFromKey(key);
  if (field === undefined) return undefined;

  const reasoningOff =
    field === "reasoning_effort" && value === "off" && supportsReasoningOff(sdk);

  // `validate` inspects the value only for the two fields with a domain; for
  // every other field the check is pure applicability, so a non-string collapses
  // to a bare `true` standing in for "some value".
  const probe: string | true = typeof value === "string" && !reasoningOff ? value : true;
  const failure = validate(sdk, modelId, field, probe);
  return failure === undefined ? undefined : invalidRequest(failure.message);
}

// ── the two tables clients read ───────────────────────────────────────────

/**
 * How the resolved sdk treats each settable key: `honored` / `ignored` /
 * `rejected` from the matrix, or `always` for the Shore-only keys (`sdk`,
 * `max_tool_iterations`) that name no matrix field.
 *
 * Clients show only `honored` and `always` keys.
 */
export function keyApplicability(sdk: Sdk, modelId: string): Record<string, Applicability | "always"> {
  const out: Record<string, Applicability | "always"> = {};
  for (const key of SAMPLER_KEYS) {
    const field = fieldFromKey(key);
    out[key] = field === undefined ? "always" : applicability(sdk, modelId, field);
  }
  return out;
}

/** The accepted `reasoning_effort` values, shipped alongside the table above. */
export const reasoningEffortDomain = reasoningDomain;

/**
 * The Rust's `scope_str` has no counterpart here. It mapped a
 * `PreferenceScope` enum onto five snake_case strings; on this side
 * `PreferenceScope` *is* those five strings, so the mapping is the identity and
 * the two spellings cannot drift apart. The fixture still records all five, so
 * a rename on either side is caught.
 */
