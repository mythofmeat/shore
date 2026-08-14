import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyDotenv, DotenvError, parseDotenv } from "../src/config/dotenv.ts";
import { loadRawConfigTable } from "../src/config/loader.ts";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-dotenv-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const parse = (text: string, env: Record<string, string> = {}) =>
  parseDotenv(text, (name) => env[name]);

describe("parseDotenv", () => {
  test("plain assignments, in file order", () => {
    expect(parse("A=1\nB=2\n")).toEqual([
      ["A", "1"],
      ["B", "2"],
    ]);
  });

  test("blank lines and comments are skipped", () => {
    expect(parse("\n# a comment\n\nA=1\n   # indented\nB=2")).toEqual([
      ["A", "1"],
      ["B", "2"],
    ]);
  });

  test("a trailing line without a newline still counts", () => {
    expect(parse("A=1")).toEqual([["A", "1"]]);
  });

  test("`export` and whitespace around `=` are accepted", () => {
    expect(parse("export A=1\n  B  =  2\n")).toEqual([
      ["A", "1"],
      ["B", "2"],
    ]);
  });

  test("`export` is only stripped as a whole word", () => {
    expect(parse("exported=1\n")).toEqual([["exported", "1"]]);
  });

  test("an empty value is an empty string, not a skip", () => {
    expect(parse("A=\nB=2\n")).toEqual([
      ["A", ""],
      ["B", "2"],
    ]);
  });

  test("trailing whitespace is dropped from an unquoted value", () => {
    expect(parse("A=1   \n")).toEqual([["A", "1"]]);
  });

  test("a `#` after whitespace starts a comment; one inside the value does not", () => {
    expect(parse("A=a #b\n")).toEqual([["A", "a"]]);
    expect(parse("A=a#b\n")).toEqual([["A", "a#b"]]);
  });

  test("single quotes are literal — no escapes, no substitution", () => {
    expect(parse("A='no $SUB and \\n raw'\n", { SUB: "x" })).toEqual([
      ["A", "no $SUB and \\n raw"],
    ]);
  });

  test("double quotes take escapes", () => {
    expect(parse('A="line\\nbreak\\ttab"\n')).toEqual([["A", "line\nbreak\ttab"]]);
  });

  test("a quoted value may contain what would otherwise end the line", () => {
    expect(parse('A="a # b"\nB=2\n')).toEqual([
      ["A", "a # b"],
      ["B", "2"],
    ]);
  });

  test("quoted values may span newlines", () => {
    expect(parse("A='one\ntwo'\n")).toEqual([["A", "one\ntwo"]]);
    expect(parse('A="one\ntwo"\n')).toEqual([["A", "one\ntwo"]]);
  });

  test("anything after a closing quote is a comment", () => {
    expect(parse('A="v" # trailing\nB=2\n')).toEqual([
      ["A", "v"],
      ["B", "2"],
    ]);
  });

  test("substitution reads earlier pairs first, then the environment", () => {
    expect(parse("A=base\nB=$A/sub\nC=${OUTER}!\n", { OUTER: "env", A: "shadowed" })).toEqual([
      ["A", "base"],
      ["B", "base/sub"],
      ["C", "env!"],
    ]);
  });

  test("an unset name expands to empty", () => {
    expect(parse("A=[$NOPE]\n")).toEqual([["A", "[]"]]);
  });

  test("an escaped `$` is literal, and so is one that names nothing", () => {
    expect(parse("A=\\$NOPE\nB=pa$$word\nC=100$\n", { NOPE: "x" })).toEqual([
      ["A", "$NOPE"],
      ["B", "pa$"],
      ["C", "100$"],
    ]);
  });

  test("a key repeated later in the file wins", () => {
    const pairs = parse("A=first\nA=second\n");
    expect(pairs.at(-1)).toEqual(["A", "second"]);
  });

  test("a line with no `=` is an error", () => {
    expect(() => parse("JUST_A_NAME\n")).toThrow(DotenvError);
  });

  test("an unterminated quote is an error", () => {
    expect(() => parse("A='unclosed\n")).toThrow(DotenvError);
    expect(() => parse('A="unclosed\n')).toThrow(DotenvError);
  });

  test("a realistic secrets file parses as written", () => {
    const text = [
      "# MOONSHOT_API_KEY=disabled",
      "ANTHROPIC_API_KEY=sk-ant-api03-AbC_dEf-123",
      "OPENROUTER_API_KEY=sk-or-v1-9f8e#7d6c",
      "",
      "TAVILY_API_KEY=tvly-Xy_Z-42   ",
    ].join("\n");
    expect(parse(text)).toEqual([
      ["ANTHROPIC_API_KEY", "sk-ant-api03-AbC_dEf-123"],
      ["OPENROUTER_API_KEY", "sk-or-v1-9f8e#7d6c"],
      ["TAVILY_API_KEY", "tvly-Xy_Z-42"],
    ]);
  });
});

describe("applyDotenv", () => {
  test("the file overrides what is already set — `from_path_override`", () => {
    const root = tempDir();
    const path = join(root, ".env");
    writeFileSync(path, "A=from_file\nB=new\n");

    const target: Record<string, string | undefined> = { A: "from_process" };
    expect(applyDotenv(path, target)).toEqual(["A", "B"]);
    expect(target).toEqual({ A: "from_file", B: "new" });
  });

  test("substitution can read a variable the process was started with", () => {
    const root = tempDir();
    const path = join(root, ".env");
    writeFileSync(path, "DERIVED=$BASE/x\n");

    const target: Record<string, string | undefined> = { BASE: "/root" };
    applyDotenv(path, target);
    expect(target.DERIVED).toBe("/root/x");
  });

  test("a file that does not parse applies nothing", () => {
    const root = tempDir();
    const path = join(root, ".env");
    writeFileSync(path, "GOOD=1\nBROKEN\n");

    const target: Record<string, string | undefined> = {};
    expect(() => applyDotenv(path, target)).toThrow(DotenvError);
    expect(target.GOOD).toBeUndefined();
  });
});

describe("loadRawConfigTable", () => {
  function load(root: string, target: Record<string, string | undefined>) {
    const warnings: string[] = [];
    loadRawConfigTable(join(root, "config.toml"), {
      env: { SHORE_CONFIG_DIR: root },
      envTarget: target,
      onWarn: (message) => warnings.push(message),
    });
    return warnings;
  }

  test("`.env` beside the config is loaded into the environment", () => {
    const root = tempDir();
    writeFileSync(join(root, "config.toml"), "");
    writeFileSync(join(root, ".env"), "SHORE_TEST_DOTENV_VAR_1234=hello_from_dotenv\n");

    const target: Record<string, string | undefined> = {};
    expect(load(root, target)).toEqual([]);
    expect(target.SHORE_TEST_DOTENV_VAR_1234).toBe("hello_from_dotenv");
  });

  test("provider keys reach the environment the credential layer reads", () => {
    const root = tempDir();
    writeFileSync(join(root, "config.toml"), "");
    writeFileSync(
      join(root, ".env"),
      "ANTHROPIC_API_KEY=sk-ant-test\nOPENROUTER_API_KEY=sk-or-test\n",
    );

    const target: Record<string, string | undefined> = {};
    load(root, target);
    expect(target.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(target.OPENROUTER_API_KEY).toBe("sk-or-test");
  });

  test("no `.env` file is fine", () => {
    const root = tempDir();
    writeFileSync(join(root, "config.toml"), "");

    const target: Record<string, string | undefined> = {};
    expect(load(root, target)).toEqual([]);
    expect(target).toEqual({});
  });

  test("a broken `.env` warns and is skipped, rather than failing the load", () => {
    const root = tempDir();
    writeFileSync(join(root, "config.toml"), "");
    writeFileSync(join(root, ".env"), "NOT_AN_ASSIGNMENT\n");

    const target: Record<string, string | undefined> = {};
    expect(load(root, target)).toEqual(["Failed to load .env file"]);
    expect(target).toEqual({});
  });

  test("the config table still loads with a `.env` present", () => {
    const root = tempDir();
    writeFileSync(join(root, "config.toml"), '[defaults]\ndisplay_name = "ren"\n');
    writeFileSync(join(root, ".env"), "A=1\n");

    const raw = loadRawConfigTable(join(root, "config.toml"), {
      env: { SHORE_CONFIG_DIR: root },
      envTarget: {},
      onWarn: () => {},
    });
    expect(raw.table).toEqual({ defaults: { display_name: "ren" } });
  });
});
