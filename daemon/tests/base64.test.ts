import { expect, test } from "bun:test";

import { base64Rejection } from "../src/util/base64.ts";

test("base64 made of the alphabet, in whole groups of four, with padding only at its end, is taken", () => {
  for (const good of ["", "QUJD", "QUI=", "QQ==", "ab+/09Zz", "QUJDRA=="]) expect(base64Rejection(good)).toBeUndefined();
});

test("a character outside the alphabet, or padding before the end, is refused with its code and where it is", () => {
  expect(base64Rejection("QU*D")).toBe("Invalid symbol 42, offset 2.");
  expect(base64Rejection("QUJD QUJD")).toBe("Invalid symbol 32, offset 4.");
  expect(base64Rejection("Q=JD")).toBe("Invalid symbol 61, offset 1.");
  expect(base64Rejection("=QJD")).toBe("Invalid symbol 61, offset 0.");
  expect(base64Rejection("QUJD-_")).toBe("Invalid symbol 45, offset 4.");
});

test("base64 that doesn't end on a whole group of four is refused: one character over as a bad length, two or three over as bad padding", () => {
  expect(base64Rejection("QUJDQ")).toBe("Invalid input length: 5");
  expect(base64Rejection("Q")).toBe("Invalid input length: 1");
  expect(base64Rejection("QUJDQU")).toBe("Invalid padding");
  expect(base64Rejection("QUJDQUI")).toBe("Invalid padding");
  expect(base64Rejection("QUJDQU=")).toBe("Invalid padding");
});
