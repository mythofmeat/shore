import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveDaemonToken,
  tokenMatches,
  TokenError,
  TOKEN_ENV,
  TOKEN_FILE,
} from "../src/config/token.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  const pending = cleanups.splice(0).reverse();
  for (const c of pending) {
    try {
      c();
    } catch {
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shore-token-"));
  return dir;
}

describe("resolving the daemon's token", () => {
  test("the environment wins, and nothing is written", () => {
    const dir = tempDir();
    const got = resolveDaemonToken({ [TOKEN_ENV]: "from-env" }, dir);
    expect(got).toEqual({ token: "from-env", source: "env" });
    expect(() => statSync(join(dir, TOKEN_FILE))).toThrow();
  });

  test("an existing file is used as-is, trimmed", () => {
    const dir = tempDir();
    writeFileSync(join(dir, TOKEN_FILE), "  on-disk\n\n");
    const got = resolveDaemonToken({}, dir);
    expect(got.token).toBe("on-disk");
    expect(got.source).toBe("file");
  });

  test("with neither, one is generated at 0600", () => {
    const dir = tempDir();
    const got = resolveDaemonToken({}, dir);
    expect(got.source).toBe("generated");
    expect(got.token).toMatch(/^[0-9a-f]{64}$/);

    const path = join(dir, TOKEN_FILE);
    expect(readFileSync(path, "utf8").trim()).toBe(got.token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a generated token is stable across restarts", () => {
    const dir = tempDir();
    const first = resolveDaemonToken({}, dir);
    const second = resolveDaemonToken({}, dir);
    expect(second.token).toBe(first.token);
    expect(second.source).toBe("file");
  });

  test("an empty SHORE_TOKEN means unset, not an empty secret", () => {
    const dir = tempDir();
    writeFileSync(join(dir, TOKEN_FILE), "on-disk");
    expect(resolveDaemonToken({ [TOKEN_ENV]: "" }, dir).token).toBe("on-disk");
    expect(resolveDaemonToken({ [TOKEN_ENV]: "   " }, dir).token).toBe("on-disk");
  });

  test("an unwritable config directory refuses, and never falls back to open", () => {
    const dir = tempDir();
    chmodSync(dir, 0o500);
    cleanups.push(() => chmodSync(dir, 0o700));

    expect(() => resolveDaemonToken({}, dir)).toThrow(TokenError);
    try {
      resolveDaemonToken({}, dir);
    } catch (e) {
      expect(String(e)).toContain(TOKEN_ENV);
    }
  });
});

describe("comparing", () => {
  test("matches only the exact token", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "ab")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
  });

  test("a missing or blank token never matches", () => {
    expect(tokenMatches("abc", undefined)).toBe(false);
    expect(tokenMatches("abc", null)).toBe(false);
    expect(tokenMatches("abc", "")).toBe(false);
    expect(tokenMatches("abc", "   ")).toBe(false);
  });

  test("surrounding whitespace is not part of the secret", () => {
    expect(tokenMatches("abc", " abc\n")).toBe(true);
  });
});

describe("a generated token", () => {
  test.skipIf(process.getuid?.() === 0)("makes the config folder it needs, and an empty token file left behind becomes owner-only", () => {
    const root = mkdtempSync(join(tmpdir(), "shore-token-"));
    const nested = join(root, "not", "yet", "here");
    const made = resolveDaemonToken({}, nested);
    expect(made.source).toBe("generated");
    expect(readFileSync(join(nested, TOKEN_FILE), "utf8")).toBe(`${made.token}\n`);
    const leftover = join(root, "leftover");
    mkdirSync(leftover);
    writeFileSync(join(leftover, TOKEN_FILE), "   \n", { mode: 0o644 });
    chmodSync(join(leftover, TOKEN_FILE), 0o644);
    expect(resolveDaemonToken({}, leftover).source).toBe("generated");
    expect(statSync(join(leftover, TOKEN_FILE)).mode & 0o777).toBe(0o600);
  });
});
