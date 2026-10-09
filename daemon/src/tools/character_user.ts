import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolsUserSpec {
  readonly name?: string;
  readonly uid?: number;
  readonly gid?: number;
}

export interface CharacterUser {
  readonly spec: string;
  readonly uid: number;
  readonly gid: number;
  readonly name: string | undefined;
  readonly home: string | undefined;
  readonly shell: string | undefined;
}

export class CharacterUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterUserError";
  }
}

const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/;
const NUMERIC_ID = /^\d+$/;
const MAX_ID = 0xffff_fffe;

const CAP_KILL = 5n;
const CAP_SETGID = 6n;
const CAP_SETUID = 7n;

const PASSED_ENV = new Set(["LANG", "LANGUAGE", "TZ"]);

const USER_BIN_DIRS = [".local/bin", ".bun/bin", ".cargo/bin"];

function numericId(text: string): number | undefined {
  if (!NUMERIC_ID.test(text)) return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) && id <= MAX_ID ? id : undefined;
}

export function parseToolsUser(value: string): ToolsUserSpec | { err: string } {
  const [first = "", second, ...rest] = value.split(":");
  const malformed = {
    err: `\`${value}\` is not a user: give a user name, a numeric uid, or uid:gid`,
  };
  if (rest.length > 0) return malformed;
  if (second !== undefined) {
    const uid = numericId(first);
    const gid = numericId(second);
    return uid === undefined || gid === undefined ? malformed : { uid, gid };
  }
  const uid = numericId(first);
  if (uid !== undefined) return { uid };
  return USER_NAME.test(first) ? { name: first } : malformed;
}

export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export type PasswdLookup = (spec: ToolsUserSpec) => Promise<PasswdEntry | undefined>;

function passwdEntry(line: string): PasswdEntry | undefined {
  const fields = line.split(":");
  if (fields.length < 7) return undefined;
  const [name = "", , uid = "", gid = "", , home = "", shell = ""] = fields;
  const userId = numericId(uid);
  const groupId = numericId(gid);
  if (name === "" || userId === undefined || groupId === undefined) return undefined;
  return { name, uid: userId, gid: groupId, home, shell };
}

function matches(entry: PasswdEntry, spec: ToolsUserSpec): boolean {
  return spec.name === undefined ? entry.uid === spec.uid : entry.name === spec.name;
}

async function getent(key: string): Promise<string | undefined> {
  return await new Promise((resolve, reject) => {
    const child = spawn("getent", ["passwd", key], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : undefined));
  });
}

async function lookUpPasswd(spec: ToolsUserSpec, lookup: PasswdLookup): Promise<PasswdEntry | undefined> {
  try {
    return await lookup(spec);
  } catch (error) {
    throw new CharacterUserError(`could not look up tools.user: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function findPasswdEntry(text: string, spec: ToolsUserSpec): PasswdEntry | undefined {
  return text.split("\n").map(passwdEntry).find((entry) => entry !== undefined && matches(entry, spec));
}

export const systemPasswd: PasswdLookup = async (spec) => {
  let output: string | undefined;
  try {
    output = await getent(spec.name ?? String(spec.uid));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    output = readFileSync("/etc/passwd", "utf8");
  }
  return output === undefined ? undefined : findPasswdEntry(output, spec);
};

export async function resolveCharacterUser(spec: string, lookup: PasswdLookup = systemPasswd): Promise<CharacterUser> {
  const parsed = parseToolsUser(spec);
  if ("err" in parsed) throw new CharacterUserError(`tools.user: ${parsed.err}`);
  const entry = await lookUpPasswd(parsed, lookup);
  if (entry === undefined) {
    if (parsed.uid === undefined) {
      throw new CharacterUserError(`tools.user names ${parsed.name ?? spec}, but this system has no user by that name`);
    }
    if (parsed.gid === undefined) {
      throw new CharacterUserError(`tools.user: uid ${String(parsed.uid)} has no passwd entry, so give its group too, as ${String(parsed.uid)}:<gid>`);
    }
    return { spec, uid: parsed.uid, gid: parsed.gid, name: undefined, home: undefined, shell: undefined };
  }
  return {
    spec,
    uid: entry.uid,
    gid: parsed.gid ?? entry.gid,
    name: entry.name,
    home: entry.home === "" ? undefined : entry.home,
    shell: entry.shell === "" ? undefined : entry.shell,
  };
}

const resolved = new Map<string, Promise<CharacterUser>>();

export async function characterUser(spec: string): Promise<CharacterUser> {
  const cached = resolved.get(spec);
  if (cached !== undefined) return await cached;
  const lookup = resolveCharacterUser(spec);
  resolved.set(spec, lookup);
  try {
    return await lookup;
  } catch (error) {
    resolved.delete(spec);
    throw error;
  }
}

export interface CapabilitySets {
  effective: bigint;
  ambient: bigint;
}

export function capabilitySets(status?: string): CapabilitySets | undefined {
  let text = status;
  if (text === undefined) {
    try {
      text = readFileSync("/proc/self/status", "utf8");
    } catch {
      return undefined;
    }
  }
  const field = (name: string): bigint | undefined => {
    const match = new RegExp(`^${name}:\\s*([0-9a-f]+)$`, "m").exec(text);
    return match?.[1] === undefined ? undefined : BigInt(`0x${match[1]}`);
  };
  const effective = field("CapEff");
  const ambient = field("CapAmb");
  return effective === undefined || ambient === undefined ? undefined : { effective, ambient };
}

const has = (set: bigint, cap: bigint): boolean => ((set >> cap) & 1n) === 1n;

export function missingCapabilities(sets: CapabilitySets | undefined = capabilitySets()): string[] {
  if (sets === undefined) return ["CAP_SETUID", "CAP_SETGID", "CAP_KILL"];
  return ([["CAP_SETUID", CAP_SETUID], ["CAP_SETGID", CAP_SETGID], ["CAP_KILL", CAP_KILL]] as const)
    .filter(([, cap]) => !has(sets.effective, cap))
    .map(([name]) => name);
}

export function canSwitchUser(sets: CapabilitySets | undefined = capabilitySets()): boolean {
  return sets !== undefined && has(sets.effective, CAP_SETUID) && has(sets.effective, CAP_SETGID);
}

export function hasAmbientCapabilities(sets: CapabilitySets | undefined = capabilitySets()): boolean {
  return sets !== undefined && sets.ambient !== 0n;
}

export function switchUserProblem(user: CharacterUser, sets: CapabilitySets | undefined = capabilitySets()): string | undefined {
  if (canSwitchUser(sets)) return undefined;
  if (process.platform !== "linux") return `tools.user (${user.spec}) needs Linux; this daemon runs on ${process.platform}`;
  return `tools.user is ${user.spec}, but the daemon cannot switch users: it needs CAP_SETUID and CAP_SETGID ` +
    `(and CAP_KILL to stop the character's commands), and has ${missingCapabilities(sets).join(", ")} missing. ` +
    `In Docker, start the container as root with cap_add SETUID, SETGID and KILL; the image drops to its own user.`;
}

export function setprivFor(path: string | undefined): string {
  const found = Bun.which("setpriv", path === undefined ? {} : { PATH: path });
  if (found === null) {
    throw new CharacterUserError("starting tools as another user, or without the daemon's capabilities, needs setpriv from util-linux, and it is not on PATH");
  }
  return found;
}

export function setprivArgs(user: CharacterUser | undefined): string[] {
  const identity = user === undefined ? [] : [
    `--reuid=${String(user.uid)}`,
    `--regid=${String(user.gid)}`,
    user.name === undefined ? "--clear-groups" : "--init-groups",
    "--no-new-privs",
  ];
  return [...identity, "--inh-caps=-all", "--ambient-caps=-all"];
}

export function characterPath(user: Pick<CharacterUser, "home">, daemonPath: string | undefined): string | undefined {
  const own = user.home === undefined ? [] : USER_BIN_DIRS.map((dir) => join(user.home ?? "", dir));
  const rest = (daemonPath ?? "").split(":").filter((entry) => entry !== "" && !own.includes(entry));
  const path = [...own, ...rest];
  return path.length === 0 ? undefined : path.join(":");
}

export function characterEnv(
  user: CharacterUser,
  daemonEnv: NodeJS.ProcessEnv,
  passEnv: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(daemonEnv)) {
    if (value !== undefined && (PASSED_ENV.has(name) || name.startsWith("LC_") || passEnv.includes(name))) env[name] = value;
  }
  const path = characterPath(user, daemonEnv.PATH);
  if (path !== undefined) env.PATH = path;
  if (user.home !== undefined) env.HOME = user.home;
  if (user.name !== undefined) {
    env.USER = user.name;
    env.LOGNAME = user.name;
  }
  if (user.shell !== undefined) env.SHELL = user.shell;
  return env;
}
