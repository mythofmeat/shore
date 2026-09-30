import { expect, test } from "bun:test";

import { outcomeOf, rejectionOf } from "../support/outcome.ts";

const TIMEOUT_MS = 100;
const neverSettles = (): Promise<never> => new Promise<never>(() => {});

test("a throw awaited through outcomeOf", async () => {
  expect(await outcomeOf(neverSettles())).toThrow();
}, TIMEOUT_MS);

test("a rejection awaited through rejectionOf", async () => {
  expect(await rejectionOf(neverSettles())).toBeDefined();
}, TIMEOUT_MS);

test("a value awaited directly", async () => {
  expect(await neverSettles()).toBeUndefined();
}, TIMEOUT_MS);
