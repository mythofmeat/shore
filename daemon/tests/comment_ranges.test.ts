import { describe, expect, test } from "bun:test";

import { commentRanges, lineNumberAt, lineStartsOf } from "../scripts/comment_ranges.ts";

function comments(source: string): string[] {
  return commentRanges(source).map((r) => source.slice(r.pos, r.end));
}

describe("commentRanges", () => {
  test("finds line, block and jsdoc comments", () => {
    const source = ["// line", "const a = 1; /* block */", "/** jsdoc */", "function f() {}"].join("\n");
    expect(comments(source)).toEqual(["// line", "/* block */", "/** jsdoc */"]);
  });

  test("keeps scanning after a template substitution", () => {
    const source = "const t = `a ${1 /* inside */} b`;\n/** after */\nfunction f() {}\n";
    expect(comments(source)).toEqual(["/* inside */", "/** after */"]);
  });

  test("keeps scanning after nested templates", () => {
    const source = "const t = `a${`b${c /* deep */}`}d`;\n// tail\n";
    expect(comments(source)).toEqual(["/* deep */", "// tail"]);
  });

  test("survives a substitution containing an object literal", () => {
    const source = "const t = `${ {a: 1} }`;\n// after\n";
    expect(comments(source)).toEqual(["// after"]);
  });

  test("ignores comment markers inside templates and strings", () => {
    const source = 'const u = `http://x/${p}/y`;\nconst s = "// not";\n/* yes */\n';
    expect(comments(source)).toEqual(["/* yes */"]);
  });

  test("ignores slashes inside regex literals", () => {
    const source = "const r = /[/]|[^/]/g;\nconst q = /\\/\\/not/;\n// real\n";
    expect(comments(source)).toEqual(["// real"]);
  });

  test("keeps scanning after division", () => {
    const source = "const n = (a + b) / 2; // one\nconst m = c / 2 / d; // two\n";
    expect(comments(source)).toEqual(["// one", "// two"]);
  });

  test("finds a regex after a keyword without swallowing the next comment", () => {
    const source = "function f(x) { return /a\\/b/.test(x); }\n// end\n";
    expect(comments(source)).toEqual(["// end"]);
  });

  test("does not report a shebang", () => {
    const source = "#!/usr/bin/env bun\n// first\n";
    expect(comments(source)).toEqual(["// first"]);
  });

  test("finds a comment inside a template substitution", () => {
    const source = "const t = `${ // in sub\n1}`;\n";
    expect(comments(source)).toEqual(["// in sub"]);
  });

  test("handles tagged templates", () => {
    const source = "tag`a${1 /* t */}b`;\n// after\n";
    expect(comments(source)).toEqual(["/* t */", "// after"]);
  });

  test("does not treat a multiline template body as comments", () => {
    const source = "const t = `line1\n// not a comment\nline2`;\n// real\n";
    expect(comments(source)).toEqual(["// real"]);
  });
});

describe("lineNumberAt", () => {
  test("reports one-based lines", () => {
    const source = "a\nb\n\nc";
    const starts = lineStartsOf(source);
    expect(lineNumberAt(starts, 0)).toBe(1);
    expect(lineNumberAt(starts, 2)).toBe(2);
    expect(lineNumberAt(starts, 4)).toBe(3);
    expect(lineNumberAt(starts, 5)).toBe(4);
  });

  test("agrees with commentRanges positions", () => {
    const source = "const a = 1;\n\n// third line\nconst b = 2;\n";
    const starts = lineStartsOf(source);
    const found = commentRanges(source);
    expect(found).toHaveLength(1);
    expect(lineNumberAt(starts, found[0]!.pos)).toBe(3);
  });
});
