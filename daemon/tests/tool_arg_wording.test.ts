import { expect, test } from "bun:test";

import { Texts } from "../src/texts/texts.ts";
import { schemaViolation } from "../src/tools/validate.ts";

const schema = {
  type: "object",
  properties: {
    mode: { enum: ["slow", "fast"] },
    at: { type: "string", format: "date-time" },
    count: { type: "integer", minimum: 1 },
    tags: { type: "array" },
    name: { type: "string" },
  },
  additionalProperties: false,
};

const texts = new Texts();

test("arguments that aren't an object are refused saying what they were", () => {
  expect(schemaViolation(texts, schema, "slow")).toBe("the arguments must be a JSON object, not a string");
  expect(schemaViolation(texts, schema, ["slow"])).toBe("the arguments must be a JSON object, not an array");
  expect(schemaViolation(texts, schema, null)).toBe("the arguments must be a JSON object, not null");
  expect(schemaViolation(texts, schema, {})).toBeUndefined();
});

test("an argument outside the schema is refused saying what it must be", () => {
  expect(schemaViolation(texts, schema, { mode: "walk" })).toBe('argument `mode` must be one of "slow", "fast"');
  expect(schemaViolation(texts, schema, { at: "soon" })).toBe('argument `at` must match the "date-time" format');
  expect(schemaViolation(texts, schema, { count: 0 })).toBe("argument `count` must be >= 1");
  expect(schemaViolation(texts, schema, { tags: "one" })).toBe("argument `tags` must be an array");
  expect(schemaViolation(texts, schema, { name: 3 })).toBe("argument `name` must be a string");
});

test("each kind of refusal is worded in the character's texts", () => {
  const mine = Texts.from({ tool_arg_not_object: "NOT {{given}}", tool_arg_enum: "ONE OF {{allowed}}", tool_arg_format: "FORMAT {{format}}", tool_arg_other: "OTHER {{keyword}}" });
  expect(schemaViolation(mine, schema, 7)).toBe("NOT a number");
  expect(schemaViolation(mine, schema, { mode: "walk" })).toBe('ONE OF "slow", "fast"');
  expect(schemaViolation(mine, schema, { at: "soon" })).toBe('FORMAT "date-time"');
  expect(schemaViolation(mine, schema, { count: 0 })).toBe("OTHER minimum");
});
