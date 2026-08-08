import { describe, expect, test } from "bun:test";

import { rustTrim as trimDuration } from "../src/config/duration.ts";
import { rustTrim as trimLines } from "../src/memory/lines.ts";
import { rustTrim as trimWire } from "../src/swp/framing.ts";

const WHITE_SPACE = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000,
];

const NOT_WHITE_SPACE = [0x0000, 0x0008, 0x000e, 0x001f, 0x200b, 0x200c, 0x2060, 0xfeff];

const implementations: [name: string, trim: (s: string) => string][] = [
  ["swp/framing", trimWire],
  ["memory/lines", trimLines],
  ["config/duration", trimDuration],
];

describe("the whitespace the wire trims", () => {
  for (const [name, trim] of implementations) {
    test(`${name} trims exactly the Unicode White_Space set`, () => {
      for (const code of WHITE_SPACE) {
        const ch = String.fromCodePoint(code);
        expect(trim(`${ch}x${ch}`), `U+${code.toString(16).toUpperCase()} should be trimmed`).toBe(
          "x",
        );
      }
    });

    test(`${name} leaves everything outside that set alone`, () => {
      for (const code of NOT_WHITE_SPACE) {
        const ch = String.fromCodePoint(code);
        const subject = `${ch}x${ch}`;
        expect(trim(subject), `U+${code.toString(16).toUpperCase()} should survive`).toBe(subject);
      }
    });
  }

  test("the three implementations agree, character for character", () => {
    for (const code of [...WHITE_SPACE, ...NOT_WHITE_SPACE]) {
      const subject = `${String.fromCodePoint(code)}x${String.fromCodePoint(code)}`;
      const answers = implementations.map(([, trim]) => trim(subject));
      expect(new Set(answers).size, `U+${code.toString(16).toUpperCase()} split them`).toBe(1);
    }
  });

  test("only the ends are trimmed, never the middle", () => {
    for (const [, trim] of implementations) {
      expect(trim("  a 　 b  ")).toBe("a 　 b");
    }
  });
});
