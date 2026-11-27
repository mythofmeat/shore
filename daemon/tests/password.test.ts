import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptablePassword, PASSWORD_FILE, PasswordFileError, PasswordStore } from "../src/web/password.ts";
import { rejectionOf } from "./support/outcome.ts";
import { testRunRoot } from "./support/tmp.ts";

const fresh = (name: string): string => mkdtempSync(join(testRunRoot(), name));

describe("the daemon's password", () => {
  test("is chosen once, kept only as an owner-only argon2id hash, and then matches only itself", async () => {
    const dir = fresh("shore-password-");
    const store = new PasswordStore(join(dir, "data"));
    expect(store.isSet()).toBe(false);
    expect(await store.matches("anything at all")).toBe(false);
    expect(await store.choose("correct horse")).toBe(true);
    expect(store.isSet()).toBe(true);
    const kept = readFileSync(join(dir, "data", PASSWORD_FILE), "utf8");
    expect(kept).toStartWith("$argon2id$v=19$m=19456,t=2,p=1$");
    expect(kept).not.toContain("correct horse");
    expect(statSync(join(dir, "data", PASSWORD_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "data")), "no temporary file is left").toEqual([PASSWORD_FILE]);
    expect([await store.matches("correct horse"), await store.matches("correct horsE"), await store.matches("")]).toEqual([true, false, false]);
    expect(await store.choose("someone else's"), "a second choice changes nothing").toBe(false);
    expect(await store.matches("correct horse")).toBe(true);
    expect(readdirSync(join(dir, "data"))).toEqual([PASSWORD_FILE]);
  });

  test("two first choices at once leave exactly one of them", async () => {
    const store = new PasswordStore(fresh("shore-password-race-"));
    const chosen = await Promise.all([store.choose("first of two"), store.choose("second of two")]);
    expect(chosen.filter(Boolean)).toHaveLength(1);
    expect(await store.matches(chosen[0] ? "first of two" : "second of two")).toBe(true);
  });

  test("changes in place, and deleting its file means none is set, without a restart", async () => {
    const dir = fresh("shore-password-change-");
    const store = new PasswordStore(dir);
    await store.choose("the old one");
    await store.change("the new one");
    expect([await store.matches("the old one"), await store.matches("the new one")]).toEqual([false, true]);
    expect(readdirSync(dir)).toEqual([PASSWORD_FILE]);
    rmSync(join(dir, PASSWORD_FILE));
    expect(store.isSet()).toBe(false);
    expect(await store.choose("after a reset")).toBe(true);
  });

  test("a change that can't land leaves the old password and no temporary file", async () => {
    const dir = fresh("shore-password-blocked-");
    const store = new PasswordStore(join(dir, "data"));
    mkdirSync(join(dir, "data", PASSWORD_FILE), { recursive: true });
    writeFileSync(join(dir, "data", PASSWORD_FILE, "in the way"), "");
    expect(String(await rejectionOf(store.change("never lands")))).toContain("EISDIR");
    expect(readdirSync(join(dir, "data"))).toEqual([PASSWORD_FILE]);
    expect(await store.choose("never lands"), "something is already there").toBe(false);
    expect(readdirSync(join(dir, "data"))).toEqual([PASSWORD_FILE]);
  });

  test("a file Shore didn't write is reported, not taken for a wrong password, and an unreadable one stops the check", async () => {
    const dir = fresh("shore-password-foreign-");
    writeFileSync(join(dir, PASSWORD_FILE), "hunter22\n");
    const store = new PasswordStore(dir);
    expect(store.isSet()).toBe(true);
    const refused = await rejectionOf(store.matches("hunter22"));
    expect(refused).toBeInstanceOf(PasswordFileError);
    expect(String(refused)).toBe(`PasswordFileError: ${join(dir, PASSWORD_FILE)} doesn’t hold a password Shore set. Delete it, then choose the password again.`);
    const blocked = fresh("shore-password-unreadable-");
    writeFileSync(join(blocked, "plain"), "");
    expect(() => new PasswordStore(join(blocked, "plain")).isSet()).toThrow("ENOTDIR");
  });

  test("must be at least eight characters, counted as characters rather than bytes", () => {
    expect(["", "seven c", "日本語日本語日本"].map(acceptablePassword)).toEqual([false, false, true]);
    expect(acceptablePassword("8 chars!")).toBe(true);
  });
});
