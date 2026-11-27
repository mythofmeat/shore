import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserName } from "../src/web/auth.ts";
import { required } from "../src/util/required.ts";
import { bearerToken, deviceName, DEVICES_FILE, DeviceStore, principalName, principalOwner } from "../src/web/devices.ts";

const dataDir = () => mkdtempSync(join(tmpdir(), "shore-devices-"));
const stored = (dir: string) => JSON.parse(readFileSync(join(dir, DEVICES_FILE), "utf8")) as { devices: { last_used_at?: number }[] };

describe("the device store", () => {
  test("starts empty without a file, and finds a device by its token only", () => {
    const dir = dataDir();
    const store = new DeviceStore(dir);
    expect(store.list()).toEqual([]);
    const { device, token } = store.create("cli", "desktop", undefined, 1_000);
    expect(device).toEqual({ id: device.id, kind: "cli", name: "desktop", createdAt: 1_000, lastUsedAt: undefined, operations: undefined });
    expect(token).toMatch(/^shore_[A-Za-z0-9_-]{43}$/);
    expect(store.authenticate("shore_not-it")).toBeUndefined();
    expect(new DeviceStore(dir).authenticate(token, 2_000)).toMatchObject({ id: device.id, lastUsedAt: 2_000 });
  });

  test("is written readable by its owner alone, as version 1 with two-space indents, making the data directory when it has to", () => {
    const dir = join(dataDir(), "not", "yet");
    const store = new DeviceStore(dir);
    const { device } = store.create("cli", "desktop", undefined, 5);
    expect(statSync(join(dir, DEVICES_FILE)).mode & 0o777).toBe(0o600);
    const digest = (JSON.parse(readFileSync(join(dir, DEVICES_FILE), "utf8")) as { devices: { digest: string }[] }).devices[0]?.digest;
    expect(readFileSync(join(dir, DEVICES_FILE), "utf8")).toBe(`{\n  "version": 1,\n  "devices": [\n    {\n      "id": "${device.id}",\n      "kind": "cli",\n      "name": "desktop",\n      "created_at": 5,\n      "digest": "${String(digest)}"\n    }\n  ]\n}\n`);
  });

  test("a sign-in that can't be saved isn't kept, and leaves no half-written file behind", () => {
    const dir = dataDir();
    const store = new DeviceStore(dir);
    const renaming = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("the disk said no"); });
    try {
      expect(() => store.create("cli", "laptop")).toThrow("the disk said no");
    } finally { renaming.mockRestore(); }
    expect([store.list(), readdirSync(dir)]).toEqual([[], []]);
    const writing = spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("the disk is full"); });
    try {
      expect(() => store.create("cli", "laptop")).toThrow("the disk is full");
    } finally { writing.mockRestore(); }
    expect(store.list()).toEqual([]);
  });

  test("a sign-out that can't be saved puts the device back where it was", () => {
    const store = new DeviceStore(dataDir());
    const names = ["one", "two", "three"].map((name) => store.create("cli", name).device);
    const renaming = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("the disk said no"); });
    try {
      expect(() => store.revoke(required(names[1]).id)).toThrow("the disk said no");
    } finally { renaming.mockRestore(); }
    expect(store.list().map((device) => device.name)).toEqual(["one", "two", "three"]);
  });

  test("a device first used a minute after it was made is written at once, and one read back from the file waits out its minute", () => {
    const dir = dataDir();
    const store = new DeviceStore(dir);
    const { token } = store.create("cli", "desktop", undefined, 0);
    store.authenticate(token, 60_000);
    expect(stored(dir).devices[0]?.last_used_at).toBe(60_000);
    new DeviceStore(dir).authenticate(token, 60_500);
    expect(stored(dir).devices[0]?.last_used_at).toBe(60_000);
  });

  test("a file the daemon can't read stops it with the reason", () => {
    const dir = dataDir();
    mkdirSync(join(dir, DEVICES_FILE));
    expect(() => new DeviceStore(dir)).toThrow("EISDIR");
  });

  test("keeps a key's operations sorted and once each", () => {
    const store = new DeviceStore(dataDir());
    expect(store.create("automation", "phone", ["status", "presence", "status"]).device.operations).toEqual(["presence", "status"]);
  });

  test("writes when a device was last used at most once a minute", () => {
    const dir = dataDir();
    const store = new DeviceStore(dir);
    const { token } = store.create("cli", "desktop", undefined, 0);
    store.authenticate(token, 100_000);
    expect(stored(dir).devices[0]?.last_used_at).toBe(100_000);
    store.authenticate(token, 159_999);
    expect(stored(dir).devices[0]?.last_used_at).toBe(100_000);
    expect(store.list()[0]?.lastUsedAt).toBe(159_999);
    store.authenticate(token, 160_000);
    expect(stored(dir).devices[0]?.last_used_at).toBe(160_000);
  });

  test("a revoked device is gone from the list and the file, and revoking it again finds nothing", () => {
    const dir = dataDir();
    const store = new DeviceStore(dir);
    const kept = store.create("cli", "laptop");
    const gone = store.create("automation", "phone", ["presence"]);
    expect(store.revoke(gone.device.id)).toBe(true);
    expect(store.revoke(gone.device.id)).toBe(false);
    expect(new DeviceStore(dir).list().map((device) => device.id)).toEqual([kept.device.id]);
    expect(store.authenticate(gone.token)).toBeUndefined();
  });

  test("a device's name is trimmed, and one that is blank, too long or holds a control character won't do", () => {
    expect(["", "   ", "x".repeat(65), "a\nb", "a\u007Fb", "a\u001Fb"].map(deviceName)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect([deviceName("  desktop  "), deviceName("x".repeat(64))?.length, deviceName("a\u0020b")]).toEqual(["desktop", 64, "a b"]);
  });

  test("a file that doesn't hold device sign-ins stops the daemon rather than forgetting them", () => {
    for (const content of ["[]", "null", "{\"devices\": [null]}", "{\"devices\": [5]}", "{\"devices\": [{\"id\": 1}]}", "{\"devices\": [{\"id\": \"a\", \"kind\": \"robot\", \"name\": \"x\", \"created_at\": 1, \"digest\": \"d\"}]}",
      "{\"devices\": [{\"id\": \"a\", \"kind\": \"cli\", \"name\": \"x\", \"created_at\": 1, \"digest\": \"d\", \"last_used_at\": \"now\"}]}",
      "{\"devices\": [{\"id\": \"a\", \"kind\": \"cli\", \"name\": \"x\", \"created_at\": 1, \"digest\": \"d\", \"operations\": [1]}]}"]) {
      const dir = dataDir();
      writeFileSync(join(dir, DEVICES_FILE), content);
      expect(() => new DeviceStore(dir)).toThrow("does not hold Shore's device sign-ins");
    }
    const dir = dataDir();
    writeFileSync(join(dir, DEVICES_FILE), "{\"devices\": [{\"id\": \"a\", \"kind\": \"automation\", \"name\": \"x\", \"created_at\": 1, \"digest\": \"d\", \"last_used_at\": 2, \"operations\": [\"presence\"]}]}");
    expect(new DeviceStore(dir).list()).toEqual([{ id: "a", kind: "automation", name: "x", createdAt: 1, lastUsedAt: 2, operations: ["presence"] }]);
  });
});

describe("who a request comes from", () => {
  test("a bearer credential is read from the Authorization header alone", () => {
    const asked = (authorization?: string) => bearerToken(new Request("http://x/", authorization === undefined ? {} : { headers: { authorization } }));
    expect(asked()).toBeUndefined();
    expect(asked("Bearer abc")).toBe("abc");
    expect(asked("bearer  abc ")).toBe("abc");
    expect(asked("Basic abc")).toBeUndefined();
    expect(asked("Bearer a b")).toBeUndefined();
  });

  test("is told apart by its browser session or its device", () => {
    const signal = new AbortController().signal;
    expect(principalOwner({ kind: "device", device: { id: "a", kind: "cli", name: "desktop", createdAt: 0, lastUsedAt: undefined, operations: undefined } })).toBe("a");
    expect(principalOwner({ kind: "browser", session: { id: "s", name: "Firefox on Linux", createdAt: 0, expiresAt: 1, lastUsedAt: 0, signal } })).toBe("s");
  });

  test("is named after its browser or its device", () => {
    const signal = new AbortController().signal;
    expect(principalName({ kind: "device", device: { id: "a", kind: "cli", name: "desktop", createdAt: 0, lastUsedAt: undefined, operations: undefined } })).toBe("desktop");
    expect(principalName({ kind: "browser", session: { id: "s", name: "Firefox on Linux", createdAt: 0, expiresAt: 1, lastUsedAt: 0, signal } })).toBe("Firefox on Linux");
  });

  test("a browser is named by what its user agent says it is and runs on", () => {
    expect(browserName(null)).toBe("Browser");
    expect(browserName("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Linux");
    expect(browserName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(browserName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge on Windows");
    expect(browserName("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(browserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) shore/4.67 Chrome/130.0 Electron/38.0 Safari/537.36")).toBe("Shore app on macOS");
    expect(browserName("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1")).toBe("Safari on iPad");
    expect(browserName("curl/8.0")).toBe("Browser");
  });
});
