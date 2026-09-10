import { rustTrim } from "../memory/lines.ts";
import { InvalidArgs } from "./errors.ts";

const U32_MAX = 4_294_967_295;
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
export const MAX_DICE_COUNT = 1000;

function parseU32(s: string): number | undefined {
  if (!/^\+?[0-9]+$/.test(s)) return undefined;
  const n = Number(s);
  return n > U32_MAX ? undefined : n;
}

function parseI32(s: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
  const n = Number(s);
  if (n < I32_MIN || n > I32_MAX) return undefined;
  return n === 0 ? 0 : n;
}

function saturatingAddI32(a: number, b: number): number {
  return Math.min(I32_MAX, Math.max(I32_MIN, a + b));
}

export interface DiceNotation {
  count: number;
  sides: number;
  modifier: number;
}

export class DiceParseError extends Error {}

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
  if (count > MAX_DICE_COUNT) {
    throw new DiceParseError(`Dice count must be at most ${MAX_DICE_COUNT}`);
  }

  const afterD = s.slice(dPos + 1);
  if (afterD === "") {
    throw new DiceParseError("Missing sides after 'd'");
  }

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

export function executeDiceRoll(notation: DiceNotation): {
  rolls: number[];
  total: number;
} {
  if (!Number.isInteger(notation.count) || notation.count < 1 || notation.count > MAX_DICE_COUNT) {
    throw new DiceParseError(`Dice count must be between 1 and ${MAX_DICE_COUNT}`);
  }
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
