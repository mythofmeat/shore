import type { Matchers } from "bun:test";

type ThrowMatcher =
  | "toThrow"
  | "toThrowError"
  | "toThrowErrorMatchingSnapshot"
  | "toThrowErrorMatchingInlineSnapshot";

type MayBeAPromise<Returned> = 0 extends 1 & Returned
  ? false
  : [Extract<Returned, PromiseLike<unknown>>] extends [never]
    ? false
    : true;

type UncallableThrowMatchers = {
  [Matcher in ThrowMatcher]: [
    "This function may return a promise. Bun waits for that promise inside the matcher, where the test's timeout cannot stop it, so one that never settles hangs bun test. Use expect(await outcomeOf(promise)).toThrow(...) from tests/support/outcome.ts.",
  ];
};

interface MatchersOfAFunctionThatMayReturnAPromise<Actual>
  extends Omit<Matchers<Actual>, ThrowMatcher | "not">,
    UncallableThrowMatchers {
  not: MatchersOfAFunctionThatMayReturnAPromise<unknown>;
}

declare module "bun:test" {
  interface Expect {
    <Actual extends (...args: never[]) => unknown>(
      actual: Actual,
      customFailMessage?: string,
    ): MayBeAPromise<ReturnType<Actual>> extends true
      ? MatchersOfAFunctionThatMayReturnAPromise<Actual>
      : Matchers<Actual>;
  }
}
