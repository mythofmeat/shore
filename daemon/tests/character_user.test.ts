import { describe, expect, test } from "bun:test";
import {
  canSwitchUser,
  capabilitySets,
  characterEnv,
  CharacterUserError,
  characterPath,
  findPasswdEntry,
  hasAmbientCapabilities,
  missingCapabilities,
  parseToolsUser,
  resolveCharacterUser,
  setprivArgs,
  switchUserProblem,
  type CharacterUser,
  type PasswdLookup,
} from "../src/tools/character_user.ts";

const PASSWD = [
  "root:x:0:0:root:/root:/bin/bash",
  "shore:x:1000:1000::/home/shore:/bin/sh",
  "qifei:x:1001:1001:Qifei:/home/qifei:/bin/bash",
  "nohome:x:1002:1003::::",
  "broken:x:abc:1004::/home/broken:/bin/sh",
].join("\n");

const fromFile: PasswdLookup = async (spec) => findPasswdEntry(PASSWD, spec);

const QIFEI: CharacterUser = { spec: "qifei", uid: 1001, gid: 1001, name: "qifei", home: "/home/qifei", shell: "/bin/bash" };

function status(effective: string, ambient: string): string {
  return `Name:\tbun\nCapInh:\t0000000000000000\nCapPrm:\t${effective}\nCapEff:\t${effective}\nCapBnd:\t00000000000000e0\nCapAmb:\t${ambient}\n`;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(CharacterUserError);
    return (error as Error).message;
  }
  throw new Error("expected the lookup to fail");
}

describe("tools.user values", () => {
  test.each([
    ["qifei", { name: "qifei" }],
    ["svc_bot-1.a", { name: "svc_bot-1.a" }],
    ["machine$", { name: "machine$" }],
    ["1001", { uid: 1001 }],
    ["1001:1002", { uid: 1001, gid: 1002 }],
    ["0", { uid: 0 }],
  ])("%s is a user", (value, parsed) => {
    expect(parseToolsUser(value)).toEqual(parsed);
  });

  test.each(["", "-rf", "a b", "qifei:1001", "1001:", ":1001", "1:2:3", "99999999999", "1001:x", "../etc"])("%j is not a user", (value) => {
    expect(parseToolsUser(value)).toEqual({ err: `\`${value}\` is not a user: give a user name, a numeric uid, or uid:gid` });
  });
});

describe("resolving tools.user", () => {
  test("a name gives the passwd entry's ids, home and shell", async () => {
    expect(await resolveCharacterUser("qifei", fromFile)).toEqual(QIFEI);
  });

  test("a uid finds its entry, and an explicit gid wins over the entry's", async () => {
    expect(await resolveCharacterUser("1001", fromFile)).toEqual({ ...QIFEI, spec: "1001" });
    expect(await resolveCharacterUser("1001:2000", fromFile)).toEqual({ ...QIFEI, spec: "1001:2000", gid: 2000 });
  });

  test("an entry without a home or shell leaves them unset", async () => {
    expect(await resolveCharacterUser("nohome", fromFile)).toEqual({ spec: "nohome", uid: 1002, gid: 1003, name: "nohome", home: undefined, shell: undefined });
  });

  test("uid:gid works without a passwd entry; a bare unknown uid or name does not", async () => {
    expect(await resolveCharacterUser("4242:4343", fromFile)).toEqual({ spec: "4242:4343", uid: 4242, gid: 4343, name: undefined, home: undefined, shell: undefined });
    expect(await failure(resolveCharacterUser("4242", fromFile))).toBe("tools.user: uid 4242 has no passwd entry, so give its group too, as 4242:<gid>");
    expect(await failure(resolveCharacterUser("ghost", fromFile))).toBe("tools.user names ghost, but this system has no user by that name");
    expect(await failure(resolveCharacterUser("broken", fromFile))).toBe("tools.user names broken, but this system has no user by that name");
    expect(await failure(resolveCharacterUser("a b", fromFile))).toBe("tools.user: `a b` is not a user: give a user name, a numeric uid, or uid:gid");
  });

  test("a failing lookup is reported as a tools.user problem", async () => {
    const failing: PasswdLookup = async () => { throw new Error("nss is down"); };
    expect(await failure(resolveCharacterUser("qifei", failing))).toBe("could not look up tools.user: nss is down");
  });

  test("the system lookup finds root", async () => {
    expect(await resolveCharacterUser("0")).toMatchObject({ uid: 0, gid: 0, name: "root" });
  });
});

describe("the daemon's capabilities", () => {
  test("the three Docker grants are enough to switch users and stop the character's commands", () => {
    const sets = capabilitySets(status("00000000000000e0", "00000000000000e0"));
    expect(sets).toEqual({ effective: 0xe0n, ambient: 0xe0n });
    expect(canSwitchUser(sets)).toBe(true);
    expect(missingCapabilities(sets)).toEqual([]);
    expect(hasAmbientCapabilities(sets)).toBe(true);
    expect(switchUserProblem(QIFEI, sets)).toBeUndefined();
  });

  test("an ordinary user without capabilities cannot switch", () => {
    const sets = capabilitySets(status("0000000000000000", "0000000000000000"));
    expect(canSwitchUser(sets)).toBe(false);
    expect(hasAmbientCapabilities(sets)).toBe(false);
    expect(missingCapabilities(sets)).toEqual(["CAP_SETUID", "CAP_SETGID", "CAP_KILL"]);
    expect(switchUserProblem(QIFEI, sets)).toContain("tools.user is qifei, but the daemon cannot switch users");
    expect(switchUserProblem(QIFEI, sets)).toContain("CAP_SETUID, CAP_SETGID, CAP_KILL missing");
  });

  test("switching without CAP_KILL is possible but reported", () => {
    const sets = capabilitySets(status("00000000000000c0", "0000000000000000"));
    expect(canSwitchUser(sets)).toBe(true);
    expect(missingCapabilities(sets)).toEqual(["CAP_KILL"]);
  });

  test("a status without capability lines switches nothing", () => {
    expect(capabilitySets("Name:\tbun\n")).toBeUndefined();
    expect(canSwitchUser(undefined)).toBe(false);
  });
});

describe("starting a process as the character", () => {
  test("setpriv switches ids, drops every capability and forbids new privileges", () => {
    expect(setprivArgs(QIFEI)).toEqual(["--reuid=1001", "--regid=1001", "--init-groups", "--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all"]);
    expect(setprivArgs({ ...QIFEI, name: undefined })).toEqual(["--reuid=1001", "--regid=1001", "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all"]);
  });

  test("without a user, setpriv only drops the daemon's capabilities", () => {
    expect(setprivArgs(undefined)).toEqual(["--inh-caps=-all", "--ambient-caps=-all"]);
  });

  test("the character gets a clean environment with its own identity", () => {
    const daemon = {
      PATH: "/usr/bin:/bin", HOME: "/home/shore", USER: "shore", LANG: "C.UTF-8", LC_TIME: "en_AU.UTF-8", TZ: "Australia/Sydney",
      ANTHROPIC_API_KEY: "sk-secret", SHORE_TOKEN: "token", TODOIST_API_KEY: "todo", CLAUDE_CONFIG_DIR: "/claude",
    };
    expect(characterEnv(QIFEI, daemon, ["TODOIST_API_KEY", "NOT_SET"])).toEqual({
      PATH: "/home/qifei/.local/bin:/home/qifei/.bun/bin:/home/qifei/.cargo/bin:/usr/bin:/bin",
      HOME: "/home/qifei", USER: "qifei", LOGNAME: "qifei", SHELL: "/bin/bash",
      LANG: "C.UTF-8", LC_TIME: "en_AU.UTF-8", TZ: "Australia/Sydney", TODOIST_API_KEY: "todo",
    });
  });

  test("the user-level install folders lead PATH once, and only with a home", () => {
    expect(characterPath(QIFEI, "/home/qifei/.cargo/bin:/usr/bin")).toBe("/home/qifei/.local/bin:/home/qifei/.bun/bin:/home/qifei/.cargo/bin:/usr/bin");
    expect(characterPath({ home: undefined }, "/usr/bin::/bin")).toBe("/usr/bin:/bin");
    expect(characterPath({ home: undefined }, undefined)).toBeUndefined();
    expect(characterEnv({ spec: "4242:4242", uid: 4242, gid: 4242, name: undefined, home: undefined, shell: undefined }, { PATH: "/bin", HOME: "/home/shore" }, []))
      .toEqual({ PATH: "/bin" });
  });
});
