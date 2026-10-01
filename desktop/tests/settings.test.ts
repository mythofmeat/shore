import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, parseSettings, readSettings, writeSettings } from "../src/settings.ts";

const directories: string[] = [];

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "shore-desktop-settings-"));
  directories.push(created);
  return created;
}

afterEach(() => {
  for (const created of directories.splice(0)) rmSync(created, { recursive: true, force: true });
});

describe("parseSettings", () => {
  test("unreadable input falls back to the defaults", () => {
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("[1, 2]")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
  });

  test("valid fields are kept and the address is normalized", () => {
    expect(parseSettings(JSON.stringify({ address: "meat:7340/workspace", closeToTray: false, zoom: 1.5, window: { width: 900, height: 700, maximized: true } }))).toEqual({
      address: "http://meat:7340", closeToTray: false, zoom: 1.5, window: { width: 900, height: 700, maximized: true },
    });
  });

  test("each invalid field falls back on its own", () => {
    expect(parseSettings(JSON.stringify({ address: "ftp://meat", closeToTray: "yes", zoom: 40, window: { width: 12.5, height: 99999, maximized: "true" } }))).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ address: "localhost", window: { width: 640 } }))).toEqual({ ...DEFAULT_SETTINGS, address: "http://localhost:7340", window: { ...DEFAULT_SETTINGS.window, width: 640 } });
  });
});

describe("readSettings and writeSettings", () => {
  test("a missing file reads as the defaults", () => {
    expect(readSettings(join(directory(), "missing.json"))).toEqual(DEFAULT_SETTINGS);
  });

  test("written settings read back, in a private file with no temporary left over", () => {
    const folder = join(directory(), "nested");
    const path = join(folder, "settings.json");
    const settings = { ...DEFAULT_SETTINGS, address: "https://shore.example.com", zoom: -1 };
    writeSettings(path, settings);
    expect(readSettings(path)).toEqual(settings);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder)).toEqual(["settings.json"]);
  });

  test("a corrupt file reads as the defaults", () => {
    const path = join(directory(), "settings.json");
    writeFileSync(path, "{\"address\": ");
    expect(readSettings(path)).toEqual(DEFAULT_SETTINGS);
  });
});
