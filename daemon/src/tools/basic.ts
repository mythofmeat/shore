/**
 * `roll_dice`, and the friendly date/time formatters that feed the prompt.
 *
 * Ported from `crates/daemon/src/tools/basic.rs`, pinned by
 * `tests/tools_fixtures/tool_handlers_parity.json`.
 *
 * Time is not a tool. The chat path injects a time marker on the user message
 * and the heartbeat prepends `[Current time: …]` to every tick, so the model
 * reads the clock from its prompt rather than spending a tool round-trip.
 * {@link formatFriendlyDate} and {@link formatFriendlyTime} are what feed those.
 */

import { rustTrim } from "../memory/lines.ts";
import { InvalidArgs } from "./errors.ts";

// ── Rust's integer parsers ──────────────────────────────────────────────
//
// `str::parse::<u32>()` is stricter than anything JavaScript offers, and the
// dice parser's error messages come straight out of it, so the strictness is
// observable. `Number("")` is 0, `Number(" 2 ")` is 2, `parseInt("2.5")` is 2,
// and `Number("0x10")` is 16 — every one of those is a parse *failure* in Rust.
//
// What Rust accepts: an optional leading `+` (and `-` for signed), then one or
// more ASCII digits, then end of string. Overflow is an error, not a clamp.

const U32_MAX = 4_294_967_295;
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;

/** `str::parse::<u32>()`. */
function parseU32(s: string): number | undefined {
  if (!/^\+?[0-9]+$/.test(s)) return undefined;
  const n = Number(s);
  return n > U32_MAX ? undefined : n;
}

/**
 * `str::parse::<i32>()`.
 *
 * The `n === 0` branch is not redundant: `Number("-0")` is `-0`, which is a
 * distinct value in JavaScript and serializes as `-0` in JSON. Rust has no such
 * thing — `"-0".parse::<i32>()` is `0` — so `2d6-0` would otherwise report a
 * modifier of `-0` to the model.
 */
function parseI32(s: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
  const n = Number(s);
  if (n < I32_MIN || n > I32_MAX) return undefined;
  return n === 0 ? 0 : n;
}

/** `i32::saturating_add`. */
function saturatingAddI32(a: number, b: number): number {
  return Math.min(I32_MAX, Math.max(I32_MIN, a + b));
}

// ── Dice notation ───────────────────────────────────────────────────────

/** Parsed dice notation (e.g. `2d6+3` → count=2, sides=6, modifier=3). */
export interface DiceNotation {
  count: number;
  sides: number;
  modifier: number;
}

/** Thrown by {@link parseDiceNotation}; the message is the Rust `Err(String)`. */
export class DiceParseError extends Error {}

/**
 * Parse dice notation like `2d6+3`, `1d20`, `4d6-1`, `d8`.
 *
 * Three details are load-bearing and all three are pinned:
 *
 * - The modifier scan skips position 0, so the `-` in `d-6` is part of the
 *   *sides* and fails as `Invalid sides: -6` rather than parsing as a
 *   modifier on an absent side count.
 * - Trimming happens once, up front. Inner spaces are not removed, so `2 d 6`
 *   fails on the count `"2 "` and `2d6 +3` fails on the sides `"6 "`.
 * - A leading `+` is accepted by Rust's integer parsers, so `+2d6` is two
 *   six-sided dice. A leading `-` is not, so `-2d6` fails.
 */
export function parseDiceNotation(notation: string): DiceNotation {
  const s = rustTrim(notation).toLowerCase();

  const dPos = s.indexOf("d");
  if (dPos === -1) {
    throw new DiceParseError(`Missing 'd' in notation: ${notation}`);
  }

  const countStr = s.slice(0, dPos);
  let count: number;
  if (countStr === "") {
    count = 1;
  } else {
    const parsed = parseU32(countStr);
    if (parsed === undefined) {
      throw new DiceParseError(`Invalid dice count: ${countStr}`);
    }
    count = parsed;
  }
  if (count === 0) {
    throw new DiceParseError("Dice count must be at least 1");
  }

  const afterD = s.slice(dPos + 1);
  if (afterD === "") {
    throw new DiceParseError("Missing sides after 'd'");
  }

  // `i > 0` in the Rust: a sign at the very start belongs to the sides.
  let modifierPos = -1;
  for (let i = 1; i < afterD.length; i += 1) {
    const c = afterD[i];
    if (c === "+" || c === "-") {
      modifierPos = i;
      break;
    }
  }

  let sidesStr: string;
  let modifier: number;
  if (modifierPos === -1) {
    sidesStr = afterD;
    modifier = 0;
  } else {
    sidesStr = afterD.slice(0, modifierPos);
    const modStr = afterD.slice(modifierPos);
    const parsed = parseI32(modStr);
    if (parsed === undefined) {
      throw new DiceParseError(`Invalid modifier: ${modStr}`);
    }
    modifier = parsed;
  }

  const sides = parseU32(sidesStr);
  if (sides === undefined) {
    throw new DiceParseError(`Invalid sides: ${sidesStr}`);
  }
  if (sides === 0) {
    throw new DiceParseError("Dice sides must be at least 1");
  }

  return { count, sides, modifier };
}

/**
 * Roll dice according to parsed notation. Returns the individual rolls and
 * their total.
 *
 * The total saturates rather than wrapping: `count` is a `u32`, so a notation
 * asking for four billion dice would otherwise overflow the running sum.
 */
export function executeDiceRoll(notation: DiceNotation): {
  rolls: number[];
  total: number;
} {
  const rolls: number[] = [];
  for (let i = 0; i < notation.count; i += 1) {
    rolls.push(1 + Math.floor(Math.random() * notation.sides));
  }
  let total = notation.modifier;
  for (const r of rolls) {
    total = saturatingAddI32(total, r);
  }
  return { rolls, total };
}

/**
 * Handle `roll_dice`.
 *
 * The echoed `notation` is the caller's raw string, not the normalized parse —
 * so a model that sent `"  2D6+1 "` sees that back and can tell its input was
 * understood as written.
 */
export function handleRollDice(input: Record<string, unknown>): unknown {
  const notation = input["notation"];
  if (typeof notation !== "string") {
    throw new InvalidArgs("missing 'notation' parameter");
  }

  let parsed: DiceNotation;
  try {
    parsed = parseDiceNotation(notation);
  } catch (e) {
    if (e instanceof DiceParseError) {
      throw new InvalidArgs(`invalid dice notation: ${e.message}`);
    }
    throw e;
  }

  const { rolls, total } = executeDiceRoll(parsed);
  return { notation, rolls, total };
}

// ── Friendly date/time ──────────────────────────────────────────────────

function ordinalSuffix(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if ((last === 1 && lastTwo === 11) || (last === 2 && lastTwo === 12) ||
      (last === 3 && lastTwo === 13)) {
    return "th";
  }
  if (last === 1) return "st";
  if (last === 2) return "nd";
  if (last === 3) return "rd";
  return "th";
}

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Human-friendly local date, e.g. `"Saturday, April 4th, 2026"`. Feeds the
 * `{{date}}` template variable so prompts can anchor freshness to "today".
 *
 * Spelled out rather than delegated to `Intl`: the Rust used chrono's `%A`/`%B`,
 * which are always English regardless of locale, and an `Intl` call would make
 * the prompt — and therefore the cache prefix — depend on the host's locale.
 */
export function formatFriendlyDate(now: Date = new Date()): string {
  const day = now.getDate();
  // Safe: `getDay()` is 0-6 and `getMonth()` is 0-11.
  const weekday = WEEKDAYS[now.getDay()] as string;
  const month = MONTHS[now.getMonth()] as string;
  return `${weekday}, ${month} ${day}${ordinalSuffix(day)}, ${now.getFullYear()}`;
}

/** Human-friendly local time, e.g. `"4:34 PM"`. Feeds the `{{time}}` variable. */
export function formatFriendlyTime(now: Date = new Date()): string {
  const hours24 = now.getHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours12}:${minutes} ${hours24 < 12 ? "AM" : "PM"}`;
}
