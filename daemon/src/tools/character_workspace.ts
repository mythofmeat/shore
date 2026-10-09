import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { characterWorkspaceDir } from "../config/dirs.ts";
import { loadCharacterConfig, type LoadedConfig } from "../config/loader.ts";
import { shoreLog } from "../log.ts";
import {
  CharacterUserError,
  characterEnv,
  characterUser,
  hasAmbientCapabilities,
  missingCapabilities,
  setprivArgs,
  setprivFor,
  switchUserProblem,
  type CharacterUser,
} from "./character_user.ts";
import { helperCommand, WorkspaceHelper } from "./workspace_helper.ts";
import { WORKSPACE_OPS, type OpArgs, type OpResult, type WorkspaceOp } from "./workspace_ops.ts";
import { envWithoutInheritedGitRepo, runProcess, type ProcessOutput } from "./process.ts";

export interface CharacterTools {
  readonly user: string | undefined;
  readonly passEnv: readonly string[];
}

export interface CharacterRunOptions {
  cwd?: string | undefined;
  stdin?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  signal?: AbortSignal | undefined;
}

interface Launch {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
}

const NO_USER: CharacterTools = { user: undefined, passEnv: [] };

const helpers = new Map<string, WorkspaceHelper>();

let warnedWithoutKill = false;

function warnIfUnkillable(user: CharacterUser): void {
  if (warnedWithoutKill || !missingCapabilities().includes("CAP_KILL")) return;
  warnedWithoutKill = true;
  shoreLog.warn(`shore: tools run as ${user.spec}, but the daemon lacks CAP_KILL, so timeouts and cancellation cannot stop the character's commands`);
}

function withChanges(base: NodeJS.ProcessEnv, changes: CharacterRunOptions["env"]): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [name, value] of Object.entries(changes ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

export class CharacterWorkspace {
  readonly dir: string;
  readonly tools: CharacterTools;

  constructor(dir: string, tools: CharacterTools = NO_USER) {
    this.dir = dir;
    this.tools = tools;
  }

  get isolated(): boolean {
    return this.tools.user !== undefined;
  }

  at(dir: string): CharacterWorkspace {
    return dir === this.dir ? this : new CharacterWorkspace(dir, this.tools);
  }

  async user(): Promise<CharacterUser | undefined> {
    if (this.tools.user === undefined) return undefined;
    const user = await characterUser(this.tools.user);
    const problem = switchUserProblem(user);
    if (problem !== undefined) throw new CharacterUserError(problem);
    warnIfUnkillable(user);
    return user;
  }

  async run(program: string, args: readonly string[], options: CharacterRunOptions = {}): Promise<ProcessOutput> {
    const launch = await this.#launch(program, args, options);
    return await runProcess(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdin: options.stdin, signal: options.signal });
  }

  async spawn(program: string, args: readonly string[], options: Pick<CharacterRunOptions, "cwd" | "env"> = {}): Promise<ChildProcessWithoutNullStreams> {
    const launch = await this.#launch(program, args, options);
    return spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  }

  async #launch(program: string, args: readonly string[], options: Pick<CharacterRunOptions, "cwd" | "env">): Promise<Launch> {
    const user = await this.user();
    if (user === undefined) {
      const env = withChanges(envWithoutInheritedGitRepo(), options.env);
      return hasAmbientCapabilities()
        ? { command: setprivFor(env.PATH), args: [...setprivArgs(undefined), "--", program, ...args], cwd: options.cwd, env }
        : { command: program, args: [...args], cwd: options.cwd, env };
    }
    const env = withChanges(characterEnv(user, process.env, this.tools.passEnv), options.env);
    const cwd = options.cwd ?? user.home ?? "/";
    return { command: setprivFor(env.PATH), args: [...setprivArgs(user), "--", "env", `--chdir=${cwd}`, "--", program, ...args], cwd: "/", env };
  }

  async call<K extends WorkspaceOp>(op: K, args: OpArgs<K>, signal?: AbortSignal): Promise<OpResult<K>> {
    if (this.tools.user === undefined) {
      const local = WORKSPACE_OPS[op] as (args: OpArgs<K>, signal?: AbortSignal) => Promise<OpResult<K>>;
      return await local(args, signal);
    }
    return await this.#helper(this.tools.user).call(op, args, signal) as OpResult<K>;
  }

  #helper(spec: string): WorkspaceHelper {
    const existing = helpers.get(spec);
    if (existing !== undefined) return existing;
    const helper = new WorkspaceHelper(spec, async () => {
      const user = await this.user();
      if (user === undefined) throw new CharacterUserError(`tools.user is unset; no helper is needed`);
      const [command = process.execPath, ...args] = helperCommand();
      const env = characterEnv(user, process.env, []);
      return { command: setprivFor(env.PATH), args: [...setprivArgs(user), "--", command, ...args], env };
    });
    helpers.set(spec, helper);
    return helper;
  }
}

export function asCharacterWorkspace(workspace: string | CharacterWorkspace): CharacterWorkspace {
  return typeof workspace === "string" ? new CharacterWorkspace(workspace) : workspace;
}

export function closeWorkspaceHelpers(): void {
  for (const helper of helpers.values()) helper.close();
  helpers.clear();
}

const toolsCache = new WeakMap<LoadedConfig, Map<string, CharacterTools>>();

function toolsOnDisk(config: LoadedConfig, name: string): CharacterTools {
  const tools = (loadCharacterConfig(config, name, () => {}) ?? config).app.tools;
  return { user: tools.user, passEnv: tools.pass_env };
}

export function characterToolsFor(config: LoadedConfig, name: string): CharacterTools {
  let byName = toolsCache.get(config);
  if (byName === undefined) {
    byName = new Map();
    toolsCache.set(config, byName);
  }
  const cached = byName.get(name);
  if (cached !== undefined) return cached;
  const found = toolsOnDisk(config, name);
  byName.set(name, found);
  return found;
}

export function characterWorkspace(config: LoadedConfig, name: string, options: { fresh?: boolean } = {}): CharacterWorkspace {
  return new CharacterWorkspace(
    characterWorkspaceDir(config.dirs.config, name, config.dirs.workspace),
    options.fresh === true ? toolsOnDisk(config, name) : characterToolsFor(config, name),
  );
}
