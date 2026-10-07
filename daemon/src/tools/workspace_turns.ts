import { mkdir, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { characterCacheDir, characterWorkspaceDir, type ShoreDirs } from "../config/dirs.ts";
import { mergeToolLoopMessages } from "../engine/merge.ts";
import type { Message } from "../engine/types.ts";
import { alternativeVersionOf, versionOf } from "../engine/versions.ts";
import { shoreLog } from "../log.ts";
import { envWithoutInheritedGitRepo, GIT_SAFETY_FLAGS, runProcess } from "./workspace.ts";

export interface WorkspaceTurns {
  readonly workspace: string;
  readonly repo: string;
}

export interface WorkspaceRewind {
  restored: string[];
  skipped: string[];
}

interface TurnRecord {
  before?: string;
  after?: string;
}

interface Change {
  path: string;
  fromMode: string;
  toMode: string;
}

const REPO_DIR = "workspace-turns.git";
const ABSENT = "000000";
const GITLINK = "160000";

export function workspaceTurnsFor(dirs: Pick<ShoreDirs, "config" | "cache" | "workspace">, character: string): WorkspaceTurns {
  return {
    workspace: characterWorkspaceDir(dirs.config, character, dirs.workspace),
    repo: join(characterCacheDir(dirs.cache, character), REPO_DIR),
  };
}

export function replyVersions(messages: readonly Message[]): string[] {
  const versions: string[] = [];
  for (const message of mergeToolLoopMessages([...messages])) {
    const version = message.role === "assistant" ? versionOf(message) : undefined;
    if (version !== undefined) versions.push(version);
  }
  return versions;
}

function liveVersions(messages: readonly Message[]): Set<string> {
  const live = new Set(replyVersions(messages));
  for (const message of messages) {
    const version = versionOf(message);
    if (version !== undefined) live.add(version);
    for (const alternative of message.alternatives ?? []) {
      const alt = alternativeVersionOf(alternative);
      if (alt !== undefined) live.add(alt);
    }
  }
  return live;
}

export async function snapshotTree(turns: WorkspaceTurns): Promise<string | undefined> {
  return await bestEffort(turns, undefined, async () => await snapshot(turns));
}

export async function recordTurn(turns: WorkspaceTurns, thread: string, version: string, before: string | undefined): Promise<void> {
  if (before === undefined) return;
  await bestEffort(turns, undefined, async () => {
    const after = await snapshot(turns);
    if (after === before) return;
    const base = `${refBase(thread)}/${version}`;
    await git(turns, ["update-ref", "--stdin"], { stdin: `update ${base}/before ${before}\nupdate ${base}/after ${after}\n` });
  });
}

export async function undoTurns(turns: WorkspaceTurns, thread: string, versions: readonly string[]): Promise<WorkspaceRewind> {
  return await replay(turns, thread, versions, (record) => [record.after, record.before]);
}

export async function redoTurns(turns: WorkspaceTurns, thread: string, versions: readonly string[]): Promise<WorkspaceRewind> {
  return await replay(turns, thread, versions, (record) => [record.before, record.after]);
}

export async function recordedTurns(turns: WorkspaceTurns, thread: string, versions: readonly string[]): Promise<string[]> {
  return await bestEffort(turns, [], async () => {
    const records = await readRecords(turns, thread);
    return versions.filter((version) => isComplete(records.get(version)));
  });
}

export async function aliasTurn(turns: WorkspaceTurns, thread: string, from: string, to: string): Promise<void> {
  await bestEffort(turns, undefined, async () => {
    const record = (await readRecords(turns, thread)).get(from);
    if (record?.before === undefined || record.after === undefined) return;
    const base = `${refBase(thread)}/${to}`;
    await git(turns, ["update-ref", "--stdin"], { stdin: `update ${base}/before ${record.before}\nupdate ${base}/after ${record.after}\n` });
  });
}

export async function pruneTurns(turns: WorkspaceTurns, thread: string, messages: readonly Message[]): Promise<void> {
  await bestEffort(turns, undefined, async () => {
    const live = liveVersions(messages);
    const records = await readRecords(turns, thread);
    const doomed = [...records.keys()].filter((version) => !live.has(version));
    if (doomed.length === 0) return;
    const lines = doomed.flatMap((version) => ["before", "after"].map((side) => `delete ${refBase(thread)}/${version}/${side}\n`));
    await git(turns, ["update-ref", "--stdin"], { stdin: lines.join("") });
    await git(turns, ["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"]);
  });
}

async function replay(
  turns: WorkspaceTurns,
  thread: string,
  versions: readonly string[],
  direction: (record: Required<TurnRecord>) => [string, string],
): Promise<WorkspaceRewind> {
  const total: WorkspaceRewind = { restored: [], skipped: [] };
  if (versions.length === 0) return total;
  return await bestEffort(turns, total, async () => {
    const records = await readRecords(turns, thread);
    for (const version of versions) {
      const record = records.get(version);
      if (!isComplete(record)) continue;
      const [from, to] = direction(record);
      const moved = await move(turns, from, to);
      total.restored.push(...moved.restored);
      total.skipped.push(...moved.skipped);
    }
    const skipped = new Set(total.skipped);
    return { restored: [...new Set(total.restored)].filter((path) => !skipped.has(path)), skipped: [...skipped] };
  });
}

function isComplete(record: TurnRecord | undefined): record is Required<TurnRecord> {
  return record?.before !== undefined && record.after !== undefined;
}

async function move(turns: WorkspaceTurns, from: string, to: string): Promise<WorkspaceRewind> {
  const changes = parseRaw(await git(turns, ["diff-tree", "-r", "-z", "--no-renames", from, to]));
  if (changes.length === 0) return { restored: [], skipped: [] };
  const current = await snapshot(turns);
  const since = new Set(parseRaw(await git(turns, ["diff-tree", "-r", "-z", "--no-renames", from, current])).map((change) => change.path));
  const skipped: string[] = [];
  const removals: string[] = [];
  const writes: string[] = [];
  for (const change of changes) {
    if (since.has(change.path)) skipped.push(change.path);
    else if (change.toMode === GITLINK || change.fromMode === GITLINK) skipped.push(change.path);
    else if (change.toMode === ABSENT) removals.push(change.path);
    else writes.push(change.path);
  }
  for (const path of removals) {
    await rm(join(turns.workspace, path), { force: true });
    await pruneEmptyParents(turns.workspace, path);
  }
  if (writes.length > 0) {
    const index = join(turns.repo, "index.rewind");
    try {
      await git(turns, ["read-tree", to], { index });
      await git(turns, ["checkout-index", "--force", "-z", "--stdin"], { index, stdin: writes.map((path) => `${path}\0`).join("") });
    } finally {
      await rm(index, { force: true });
    }
  }
  return { restored: [...removals, ...writes], skipped };
}

async function pruneEmptyParents(root: string, path: string): Promise<void> {
  for (let parent = dirname(path); parent !== "." && parent !== "/" && parent !== ""; parent = dirname(parent)) {
    try {
      await rmdir(join(root, parent));
    } catch {
      return;
    }
  }
}

function parseRaw(output: string): Change[] {
  const fields = output.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    if (!meta.startsWith(":") || path === "") continue;
    const [fromMode = ABSENT, toMode = ABSENT] = meta.slice(1).split(" ");
    changes.push({ path, fromMode, toMode });
  }
  return changes;
}

async function readRecords(turns: WorkspaceTurns, thread: string): Promise<Map<string, TurnRecord>> {
  const records = new Map<string, TurnRecord>();
  if (!(await exists(join(turns.repo, "HEAD")))) return records;
  const base = refBase(thread);
  const output = await git(turns, ["for-each-ref", "--format=%(refname) %(objectname)", base]);
  for (const line of output.split("\n")) {
    const [ref, sha] = line.split(" ");
    if (ref === undefined || sha === undefined || !ref.startsWith(`${base}/`)) continue;
    const [version, side] = ref.slice(base.length + 1).split("/");
    if (version === undefined || (side !== "before" && side !== "after")) continue;
    const record = records.get(version) ?? {};
    record[side] = sha;
    records.set(version, record);
  }
  return records;
}

function refBase(thread: string): string {
  return `refs/turns/${Buffer.from(thread, "utf8").toString("hex")}`;
}

async function snapshot(turns: WorkspaceTurns): Promise<string> {
  await ensureRepo(turns);
  await git(turns, ["add", "--all", "--", "."]);
  return (await git(turns, ["write-tree"])).trim();
}

async function ensureRepo(turns: WorkspaceTurns): Promise<void> {
  if (await exists(join(turns.repo, "HEAD"))) return;
  await mkdir(turns.repo, { recursive: true });
  const init = await runProcess("git", [...GIT_SAFETY_FLAGS, "init", "--quiet", "--bare", turns.repo], { env: envWithoutInheritedGitRepo() });
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
}

async function git(turns: WorkspaceTurns, args: string[], options: { stdin?: string; index?: string } = {}): Promise<string> {
  const env = envWithoutInheritedGitRepo();
  if (options.index !== undefined) env["GIT_INDEX_FILE"] = options.index;
  const output = await runProcess("git", [
    ...GIT_SAFETY_FLAGS,
    "-c", "safe.directory=*",
    "-c", "core.autocrlf=false",
    "-c", "core.symlinks=true",
    `--git-dir=${turns.repo}`,
    `--work-tree=${turns.workspace}`,
    ...args,
  ], { cwd: turns.workspace, env, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) });
  if (output.code !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${output.stderr.trim()}`);
  return output.stdout;
}

const queues = new Map<string, Promise<void>>();

async function bestEffort<T>(turns: WorkspaceTurns, fallback: T, run: () => Promise<T>): Promise<T> {
  if (!(await exists(turns.workspace))) return fallback;
  const prior = queues.get(turns.repo) ?? Promise.resolve();
  const next = prior.then(run);
  const settled = next.then(() => undefined, () => undefined);
  queues.set(turns.repo, settled);
  void settled.then(() => {
    if (queues.get(turns.repo) === settled) queues.delete(turns.repo);
  });
  try {
    return await next;
  } catch (error) {
    shoreLog.warn(`shore: workspace turn history unavailable for ${turns.workspace}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
