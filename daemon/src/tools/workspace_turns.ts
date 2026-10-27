import { dirname, join } from "node:path";

import { characterCacheDir, characterWorkspaceDir, type ShoreDirs } from "../config/dirs.ts";
import { mergeToolLoopMessages } from "../engine/merge.ts";
import type { Message } from "../engine/types.ts";
import { alternativeVersionOf, versionOf } from "../engine/versions.ts";
import { shoreLog } from "../log.ts";
import { CharacterWorkspace } from "./character_workspace.ts";
import { characterGitIdentity, GIT_SAFETY_FLAGS } from "./workspace.ts";

export interface WorkspaceTurns {
  readonly workspace: string;
  readonly repo: string;
  readonly character?: CharacterWorkspace;
  readonly name?: string;
}

export interface WorkspaceRewind {
  restored: string[];
  skipped: string[];
}

interface Snapshot {
  id: string;
  head?: string;
  branch?: string;
}

interface Segment {
  before?: Snapshot;
  after?: Snapshot;
  seen?: string;
}

interface CompleteSegment {
  before: Snapshot;
  after: Snapshot;
  seen?: string;
}

interface TurnRecord {
  refs: string[];
  segments: Map<string, Segment>;
}

interface CallRecord {
  before: string;
  after: string;
  seen?: string;
}

interface Taken {
  id: string;
  label: string;
}

interface WriteWindow {
  readonly owner: object;
  paths: ReadonlySet<string>;
  head: boolean;
  readonly overlaps: Set<WriteWindow>;
  readonly closed: Promise<void>;
  readonly close: () => void;
}

type Direction = "undo" | "redo";

interface Change {
  path: string;
  fromMode: string;
  toMode: string;
  toSha: string;
}

export interface WorkspaceChange {
  path: string;
  deleted: boolean;
}

const REPO_DIR = "workspace-turns.git";
const ABSENT = "000000";
const GITLINK = "160000";
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "shore",
  GIT_AUTHOR_EMAIL: "shore@shore.local",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "shore",
  GIT_COMMITTER_EMAIL: "shore@shore.local",
  GIT_COMMITTER_DATE: "@0 +0000",
};

export function workspaceTurnsFor(
  dirs: Pick<ShoreDirs, "config" | "cache" | "workspace">,
  character: string,
  runAs?: CharacterWorkspace,
): WorkspaceTurns {
  const workspace = characterWorkspaceDir(dirs.config, character, dirs.workspace);
  return {
    workspace,
    repo: join(characterCacheDir(dirs.cache, character), REPO_DIR),
    name: character,
    ...(runAs?.isolated === true ? { character: runAs.at(workspace) } : {}),
  };
}

function accessOf(turns: WorkspaceTurns): CharacterWorkspace {
  return turns.character ?? new CharacterWorkspace(turns.workspace);
}

export async function isolatedTurnsRepo(workspace: CharacterWorkspace, character: string): Promise<string> {
  const user = await workspace.user();
  if (user?.home === undefined) throw new Error(`${workspace.tools.user ?? "the character's user"} has no home directory to keep workspace history in`);
  return join(user.home, ".cache", "shore", "workspace-turns", `${character}.git`);
}

async function repoOf(turns: WorkspaceTurns): Promise<string> {
  return turns.character === undefined ? turns.repo : await isolatedTurnsRepo(turns.character, turns.name ?? "workspace");
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

const openWindows = new Map<string, Set<WriteWindow>>();

function openWindow(turns: WorkspaceTurns, owner: object): WriteWindow {
  const { promise, resolve } = Promise.withResolvers<void>();
  const window: WriteWindow = { owner, paths: new Set(), head: false, overlaps: new Set(), closed: promise, close: resolve };
  const live = openWindows.get(turns.workspace) ?? new Set<WriteWindow>();
  for (const other of live) {
    other.overlaps.add(window);
    window.overlaps.add(other);
  }
  live.add(window);
  openWindows.set(turns.workspace, live);
  return window;
}

function closeWindow(turns: WorkspaceTurns, window: WriteWindow, paths: Iterable<string>, head: boolean): void {
  window.paths = new Set(paths);
  window.head = head;
  const live = openWindows.get(turns.workspace);
  live?.delete(window);
  if (live?.size === 0) openWindows.delete(turns.workspace);
  window.close();
}

async function foreignTo(window: WriteWindow): Promise<{ paths: Set<string>; head: boolean }> {
  const others = [...window.overlaps].filter((other) => other.owner !== window.owner);
  window.overlaps.clear();
  await Promise.all(others.map((other) => other.closed));
  return { paths: new Set(others.flatMap((other) => [...other.paths])), head: others.some((other) => other.head) };
}

export async function withWriteWindow<T>(
  turns: WorkspaceTurns,
  owner: object,
  run: () => Promise<{ value: T; paths: Iterable<string>; head?: boolean }>,
): Promise<{ value: T; foreign: () => Promise<{ paths: Set<string>; head: boolean }> }> {
  const window = openWindow(turns, owner);
  let paths: Iterable<string> = [];
  let head = true;
  try {
    const done = await run();
    paths = done.paths;
    head = done.head ?? false;
    return { value: done.value, foreign: async () => await foreignTo(window) };
  } finally {
    closeWindow(turns, window, paths, head);
  }
}

interface WriteGroup {
  window: WriteWindow;
  before: Promise<Taken | undefined>;
  running: number;
}

export class WorkspaceRecorder {
  readonly #turns: WorkspaceTurns;
  readonly #owner = {};
  readonly #records: Promise<CallRecord | undefined>[] = [];
  #group: WriteGroup | undefined;

  constructor(turns: WorkspaceTurns) {
    this.#turns = turns;
  }

  readonly track = async <T>(run: () => Promise<T>): Promise<T> => {
    let group = this.#group;
    if (group === undefined) {
      const window = openWindow(this.#turns, this.#owner);
      group = { window, before: bestEffort(this.#turns, undefined, async () => await turnSnapshot(this.#turns)), running: 0 };
      this.#group = group;
    }
    group.running += 1;
    try {
      await group.before;
      return await run();
    } finally {
      group.running -= 1;
      if (group.running === 0) {
        this.#group = undefined;
        this.#records.push(this.#finish(group));
      }
    }
  };

  async settle(thread: string, version: string): Promise<void> {
    const records = (await Promise.all(this.#records.splice(0))).filter((record) => record !== undefined);
    if (records.length === 0) return;
    const base = `${refBase(thread)}/${version}`;
    const lines = records.flatMap((record, index) => [
      `update ${base}/${String(index)}/before ${record.before}\n`,
      `update ${base}/${String(index)}/after ${record.after}\n`,
      ...(record.seen === undefined ? [] : [`update ${base}/${String(index)}/seen ${record.seen}\n`]),
    ]);
    await bestEffort(this.#turns, undefined, async () => {
      await git(this.#turns, ["update-ref", "--stdin"], { stdin: lines.join("") });
    });
  }

  async discard(): Promise<void> {
    await Promise.all(this.#records.splice(0));
  }

  async #finish(group: WriteGroup): Promise<CallRecord | undefined> {
    const turns = this.#turns;
    const before = await group.before;
    const after = before === undefined ? undefined : await bestEffort(turns, undefined, async () => await turnSnapshot(turns));
    const changed = before === undefined || after === undefined || after.id === before.id
      ? []
      : await bestEffort(turns, [], async () => await diff(turns, before.id, after.id));
    closeWindow(turns, group.window, changed.map((change) => change.path), before?.label !== after?.label);
    const foreign = await foreignTo(group.window);
    if (before === undefined || after === undefined || after.id === before.id) return undefined;
    const ambiguous = changed.filter((change) => foreign.paths.has(change.path));
    const headAmbiguous = foreign.head && before.label !== after.label;
    if (ambiguous.length === 0 && !headAmbiguous) return { before: before.id, after: after.id };
    shoreLog.warn(
      `shore: another writer changed ${turns.workspace} while a reply's tool call ran; undoing that reply will leave ` +
        `${ambiguous.length === 0 ? "" : JSON.stringify(ambiguous.map((change) => change.path))}${ambiguous.length > 0 && headAmbiguous ? " and " : ""}${headAmbiguous ? "HEAD" : ""} alone`,
    );
    const own = await bestEffort(turns, undefined, async () =>
      await ownSnapshot(turns, before, changed.filter((change) => !foreign.paths.has(change.path)), headAmbiguous ? before.label : after.label));
    return own === undefined ? undefined : { before: before.id, after: own, seen: after.id };
  }
}

async function ownSnapshot(turns: WorkspaceTurns, before: Taken, own: readonly Change[], label: string): Promise<string> {
  const repo = await repoOf(turns);
  const index = join(repo, "index.own");
  let tree: string;
  try {
    await git(turns, ["read-tree", `${before.id}^{tree}`], { env: { GIT_INDEX_FILE: index } });
    if (own.length > 0) {
      const entries = own.map((change) => change.toMode === ABSENT
        ? `0 ${"0".repeat(40)}\t${change.path}\0`
        : `${change.toMode} ${change.toSha}\t${change.path}\0`);
      await git(turns, ["update-index", "-z", "--index-info"], { env: { GIT_INDEX_FILE: index }, stdin: entries.join("") });
    }
    tree = (await git(turns, ["write-tree"], { env: { GIT_INDEX_FILE: index } })).trim();
  } finally {
    await accessOf(turns).call("remove", { root: repo, path: "index.own" });
  }
  return label === "" ? tree : (await git(turns, ["commit-tree", tree, "-m", label], { env: SNAPSHOT_IDENTITY })).trim();
}

export async function workspaceTree(turns: WorkspaceTurns): Promise<string> {
  return await serialized(turns, async () => await snapshot(turns));
}

export async function workspaceChanges(turns: WorkspaceTurns, since: string): Promise<{ tree: string; changes: WorkspaceChange[] }> {
  return await serialized(turns, async () => {
    const tree = await snapshot(turns);
    const changes = (await diff(turns, since, tree)).filter((change) => !isGitlink(change));
    return { tree, changes: changes.map((change) => ({ path: change.path, deleted: change.toMode === ABSENT })) };
  });
}

export async function restorePaths(turns: WorkspaceTurns, tree: string, paths: readonly string[]): Promise<void> {
  const wanted = new Set(paths);
  await withWriteWindow(turns, {}, async () => {
    const restored = await serialized(turns, async () => {
      const changes = await diff(turns, await snapshot(turns), tree);
      return await checkOut(turns, tree, changes.filter((change) => wanted.has(change.path) && !isGitlink(change)));
    });
    return { value: undefined, paths: restored, head: false };
  });
}

export async function undoTurns(turns: WorkspaceTurns, thread: string, versions: readonly string[]): Promise<WorkspaceRewind> {
  return await replay(turns, thread, versions, "undo");
}

export async function redoTurns(turns: WorkspaceTurns, thread: string, versions: readonly string[]): Promise<WorkspaceRewind> {
  return await replay(turns, thread, versions, "redo");
}

export async function recordedTurns(turns: WorkspaceTurns, thread: string, versions: readonly string[]): Promise<string[]> {
  return await bestEffort(turns, [], async () => {
    const records = await readRecords(turns, thread);
    return versions.filter((version) => completeSegments(records.get(version)).length > 0);
  });
}

export async function aliasTurn(turns: WorkspaceTurns, thread: string, from: string, to: string): Promise<void> {
  await bestEffort(turns, undefined, async () => {
    const record = (await readRecords(turns, thread)).get(from);
    if (record === undefined || completeSegments(record).length === 0) return;
    const base = refBase(thread);
    const lines = [...record.segments].flatMap(([key, segment]) => {
      const prefix = `${base}/${to}${key === "" ? "" : `/${key}`}`;
      return [
        ...(segment.before === undefined ? [] : [`update ${prefix}/before ${segment.before.id}\n`]),
        ...(segment.after === undefined ? [] : [`update ${prefix}/after ${segment.after.id}\n`]),
        ...(segment.seen === undefined ? [] : [`update ${prefix}/seen ${segment.seen}\n`]),
      ];
    });
    await git(turns, ["update-ref", "--stdin"], { stdin: lines.join("") });
  });
}

export async function pruneTurns(turns: WorkspaceTurns, thread: string, messages: readonly Message[]): Promise<void> {
  await bestEffort(turns, undefined, async () => {
    const live = liveVersions(messages);
    const records = await readRecords(turns, thread);
    const doomed = [...records.keys()].filter((version) => !live.has(version));
    if (doomed.length === 0) return;
    const lines = doomed.flatMap((version) => records.get(version)?.refs.map((ref) => `delete ${ref}\n`) ?? []);
    await git(turns, ["update-ref", "--stdin"], { stdin: lines.join("") });
    await git(turns, ["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"]);
  });
}

async function replay(
  turns: WorkspaceTurns,
  thread: string,
  versions: readonly string[],
  direction: Direction,
): Promise<WorkspaceRewind> {
  const total: WorkspaceRewind = { restored: [], skipped: [] };
  if (versions.length === 0) return total;
  const { value } = await withWriteWindow(turns, {}, async () => {
    let head = false;
    const rewind = await bestEffort(turns, total, async () => {
      const records = await readRecords(turns, thread);
      for (const version of versions) {
        const segments = completeSegments(records.get(version));
        for (const segment of direction === "undo" ? [...segments].reverse() : segments) {
          const [from, to] = direction === "undo" ? [segment.after, segment.before] : [segment.before, segment.after];
          const moved = await move(turns, from.id, to.id);
          total.restored.push(...moved.restored);
          total.skipped.push(...moved.skipped);
          if (direction === "undo" && segment.seen !== undefined) {
            total.skipped.push(...(await diff(turns, segment.after.id, segment.seen)).map((change) => change.path));
          }
        }
        const chains = headChains(segments);
        for (const chain of direction === "undo" ? [...chains].reverse() : chains) {
          const [from, to] = direction === "undo" ? [chain.after, chain.before] : [chain.before, chain.after];
          if (from.head !== to.head || from.branch !== to.branch) head = true;
          await moveHead(turns, chain, from, to, direction);
        }
      }
      const skipped = new Set(total.skipped);
      return { restored: [...new Set(total.restored)].filter((path) => !skipped.has(path)), skipped: [...skipped] };
    });
    return { value: rewind, paths: rewind.restored, head };
  });
  return value;
}

function completeSegments(record: TurnRecord | undefined): CompleteSegment[] {
  if (record === undefined) return [];
  return [...record.segments]
    .toSorted(([a], [b]) => (a === "" ? -1 : Number(a)) - (b === "" ? -1 : Number(b)))
    .flatMap(([, segment]) => segment.before === undefined || segment.after === undefined ? [] : [{ ...segment, before: segment.before, after: segment.after }]);
}

function headChains(segments: readonly CompleteSegment[]): CompleteSegment[] {
  const chains: CompleteSegment[] = [];
  for (const segment of segments) {
    const last = chains.at(-1);
    if (last !== undefined && last.after.head === segment.before.head && last.after.branch === segment.before.branch) {
      chains[chains.length - 1] = { before: last.before, after: segment.after };
    } else {
      chains.push({ before: segment.before, after: segment.after });
    }
  }
  return chains;
}

async function move(turns: WorkspaceTurns, from: string, to: string): Promise<WorkspaceRewind> {
  const changes = await diff(turns, from, to);
  if (changes.length === 0) return { restored: [], skipped: [] };
  const since = new Set((await diff(turns, from, await snapshot(turns))).map((change) => change.path));
  const skipped: string[] = [];
  const moving: Change[] = [];
  for (const change of changes) {
    if (since.has(change.path) || isGitlink(change)) skipped.push(change.path);
    else moving.push(change);
  }
  return { restored: await checkOut(turns, to, moving), skipped };
}

async function checkOut(turns: WorkspaceTurns, tree: string, changes: readonly Change[]): Promise<string[]> {
  const removals = changes.filter((change) => change.toMode === ABSENT).map((change) => change.path);
  const writes = changes.filter((change) => change.toMode !== ABSENT).map((change) => change.path);
  const access = accessOf(turns);
  for (const path of removals) {
    await access.call("remove", { root: turns.workspace, path });
  }
  if (writes.length > 0) {
    const repo = await repoOf(turns);
    const index = join(repo, "index.rewind");
    try {
      await git(turns, ["read-tree", tree], { env: { GIT_INDEX_FILE: index } });
      await git(turns, ["checkout-index", "--force", "-z", "--stdin"], { env: { GIT_INDEX_FILE: index }, stdin: writes.map((path) => `${path}\0`).join("") });
    } finally {
      await access.call("remove", { root: repo, path: "index.rewind" });
    }
  }
  return [...removals, ...writes];
}

function isGitlink(change: Change): boolean {
  return change.toMode === GITLINK || change.fromMode === GITLINK;
}

async function diff(turns: WorkspaceTurns, from: string, to: string): Promise<Change[]> {
  return parseRaw(await git(turns, ["diff-tree", "-r", "-z", "--no-renames", from, to]));
}

function parseRaw(output: string): Change[] {
  const fields = output.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    if (!meta.startsWith(":") || path === "") continue;
    const [fromMode = ABSENT, toMode = ABSENT, , toSha = ""] = meta.slice(1).split(" ");
    changes.push({ path, fromMode, toMode, toSha });
  }
  return changes;
}

async function readRecords(turns: WorkspaceTurns, thread: string): Promise<Map<string, TurnRecord>> {
  const records = new Map<string, TurnRecord>();
  if (!(await exists(turns, join(await repoOf(turns), "HEAD")))) return records;
  const base = refBase(thread);
  const output = await git(turns, ["for-each-ref", "--format=%(refname) %(objectname) %(contents:subject)", base]);
  for (const line of output.split("\n")) {
    const [ref, sha, head, branch] = line.split(" ");
    if (ref === undefined || sha === undefined || !ref.startsWith(`${base}/`)) continue;
    const parts = ref.slice(base.length + 1).split("/");
    const [version] = parts;
    const side = parts.at(-1);
    const key = parts.length === 3 ? parts[1] : parts.length === 2 ? "" : undefined;
    if (version === undefined || key === undefined || (side !== "before" && side !== "after" && side !== "seen")) continue;
    const record = records.get(version) ?? { refs: [], segments: new Map<string, Segment>() };
    record.refs.push(ref);
    const segment = record.segments.get(key) ?? {};
    if (side === "seen") segment.seen = sha;
    else segment[side] = { id: sha, ...(head === undefined || head === "" ? {} : { head }), ...(branch === undefined || branch === "" ? {} : { branch }) };
    record.segments.set(key, segment);
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

async function turnSnapshot(turns: WorkspaceTurns): Promise<Taken> {
  const tree = await snapshot(turns);
  const position = await workspaceGit(turns, ["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"]);
  const [head, branch] = position?.split("\n") ?? [];
  if (head === undefined || head === "") return { id: tree, label: "" };
  const label = branch === undefined || branch === "HEAD" ? head : `${head} ${branch}`;
  return { id: (await git(turns, ["commit-tree", tree, "-m", label], { env: SNAPSHOT_IDENTITY })).trim(), label };
}

async function moveHead(turns: WorkspaceTurns, record: CompleteSegment, from: Snapshot, to: Snapshot, direction: Direction): Promise<void> {
  if (from.head === to.head && from.branch === to.branch) return;
  const leave = (reason: string): void => {
    shoreLog.warn(`shore: left HEAD alone in ${turns.workspace} while ${direction === "undo" ? "undoing" : "redoing"} a reply's workspace changes: ${reason}`);
  };
  if (from.head === undefined || to.head === undefined) return leave("the workspace had no commits on one side of the reply");
  if (from.branch !== to.branch) return leave("the reply switched branches");
  const position = await workspaceGit(turns, ["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"]);
  const [current, branch] = position?.split("\n") ?? [];
  if (current === undefined || current === "") return leave("HEAD can't be read");
  if ((branch === "HEAD" ? undefined : branch) !== to.branch) return leave("a different branch is checked out now");
  const trees = await workspaceGit(turns, ["rev-parse", `${current}^{tree}`, `${from.head}^{tree}`, `${to.head}^{tree}`]);
  const [currentTree, fromTree, toTree] = trees?.split("\n") ?? [];
  if (toTree === undefined) return leave("the reply's commits are gone");
  if (currentTree !== fromTree) return leave("HEAD has moved since");
  const dropped = await workspaceGit(turns, ["rev-list", "--count", current, "--not", to.head]);
  const unpushed = await workspaceGit(turns, ["rev-list", "--count", current, "--not", to.head, "--remotes"]);
  const target = dropped !== undefined && dropped === unpushed ? to.head : await headCommit(turns, record, current, toTree, direction);
  if (target === undefined) return leave("git commit-tree failed");
  if ((await workspaceGit(turns, ["reset", "--quiet", target])) === undefined) leave("git reset failed");
}

async function headCommit(turns: WorkspaceTurns, record: CompleteSegment, parent: string, tree: string, direction: Direction): Promise<string | undefined> {
  const range = `${record.before.head}..${record.after.head}`;
  const subjects = (await workspaceGit(turns, ["log", "--format=%s", range]))?.split("\n").filter((subject) => subject !== "") ?? [];
  const [verb, verbs] = direction === "undo" ? ["Revert", "reverts"] : ["Reapply", "reapplies"];
  const [subject] = subjects;
  const title = subjects.length === 1 && subject !== undefined ? `${verb} "${subject}"` : `${verb} ${subjects.length} commits`;
  const [name, email] = characterGitIdentity(turns.name ?? "shore");
  return await workspaceGit(turns, ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit-tree", tree, "-p", parent, "-m", title, "-m", `This ${verbs} ${range}.`]);
}

async function workspaceGit(turns: WorkspaceTurns, args: string[]): Promise<string | undefined> {
  const output = await accessOf(turns).run("git", [...GIT_SAFETY_FLAGS, ...args], {
    cwd: turns.workspace,
    env: { GIT_CEILING_DIRECTORIES: dirname(turns.workspace) },
  });
  return output.code === 0 ? output.stdout.trim() : undefined;
}

async function ensureRepo(turns: WorkspaceTurns): Promise<void> {
  const repo = await repoOf(turns);
  if (await exists(turns, join(repo, "HEAD"))) return;
  const access = accessOf(turns);
  await access.call("mkdir", { path: repo });
  const init = await access.run("git", [...GIT_SAFETY_FLAGS, "init", "--quiet", "--bare", repo]);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
}

async function git(turns: WorkspaceTurns, args: string[], options: { stdin?: string; env?: Record<string, string> } = {}): Promise<string> {
  const output = await accessOf(turns).run("git", [
    ...GIT_SAFETY_FLAGS,
    "-c", "safe.directory=*",
    "-c", "core.autocrlf=false",
    "-c", "core.symlinks=true",
    `--git-dir=${await repoOf(turns)}`,
    `--work-tree=${turns.workspace}`,
    ...args,
  ], {
    cwd: turns.workspace,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
  if (output.code !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${output.stderr.trim()}`);
  return output.stdout;
}

const queues = new Map<string, Promise<void>>();

async function serialized<T>(turns: WorkspaceTurns, run: () => Promise<T>): Promise<T> {
  const prior = queues.get(turns.repo) ?? Promise.resolve();
  const next = prior.then(run);
  const settled = next.then(() => undefined, () => undefined);
  queues.set(turns.repo, settled);
  void settled.then(() => {
    if (queues.get(turns.repo) === settled) queues.delete(turns.repo);
  });
  return await next;
}

async function bestEffort<T>(turns: WorkspaceTurns, fallback: T, run: () => Promise<T>): Promise<T> {
  if (!(await exists(turns, turns.workspace).catch(() => false))) return fallback;
  try {
    return await serialized(turns, run);
  } catch (error) {
    shoreLog.warn(`shore: workspace turn history unavailable for ${turns.workspace}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

async function exists(turns: WorkspaceTurns, path: string): Promise<boolean> {
  const [found = false] = await accessOf(turns).call("exists", { paths: [path] });
  return found;
}
