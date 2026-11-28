import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";

import { defaultToolsConfig, defaultTriggersConfig, promptWorkspaceFiles, type ToolsConfig, type TriggersConfig } from "../config/app.ts";
import { characterWorkspaceDir } from "../config/dirs.ts";
import { loadCharacterConfig, type LoadedConfig } from "../config/loader.ts";
import { shoreLog } from "../log.ts";
import {
  CharacterUserError,
  characterEnv,
  characterUser,
  hasAmbientCapabilities,
  missingCapabilities,
  runsWithNoNewPrivs,
  setprivArgs,
  setprivFor,
  switchUserProblem,
  type CharacterUser,
} from "./character_user.ts";
import { helperCommand, WorkspaceHelper } from "./workspace_helper.ts";
import { WORKSPACE_OPS, type OpArgs, type OpResult, type WorkspaceOp } from "./workspace_ops.ts";
import { envWithoutInheritedGitRepo, runProcess, type ProcessOutput, type ProcessStreams } from "./process.ts";
import { Texts, type TextsSource } from "../texts/texts.ts";

export interface CharacterTools {
  readonly user: string | undefined;
  readonly passEnv: readonly string[];
  readonly noNewPrivs: boolean;
  readonly checkLimitMs: number;
}

export interface CharacterRunOptions {
  cwd?: string | undefined;
  stdin?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  signal?: AbortSignal | undefined;
  stopped?: ((output: ProcessStreams) => void) | undefined;
}

interface Launch {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
}

function toolsFrom(tools: ToolsConfig, triggers: TriggersConfig): CharacterTools {
  return { user: tools.user, passEnv: tools.pass_env, noNewPrivs: tools.no_new_privs, checkLimitMs: triggers.check_time_limit.asMillis() };
}

const NO_USER = toolsFrom(defaultToolsConfig(), defaultTriggersConfig());

const helpers = new Map<string, WorkspaceHelper>();

let warnedWithoutKill = false;

function warnIfUnkillable(user: CharacterUser): void {
  if (warnedWithoutKill || !missingCapabilities().includes("CAP_KILL")) return;
  warnedWithoutKill = true;
  shoreLog.warn(`shore: tools run as ${user.spec}, but the daemon lacks CAP_KILL, so timeouts and cancellation cannot stop the character's commands`);
}

const warnedNoNewPrivs = new Set<string>();

export function warnIfNoNewPrivsInherited(tools: CharacterTools, user: CharacterUser, status?: string): void {
  if (tools.noNewPrivs || warnedNoNewPrivs.has(user.spec) || !runsWithNoNewPrivs(status)) return;
  warnedNoNewPrivs.add(user.spec);
  shoreLog.warn(`shore: tools run as ${user.spec} may raise privileges (tools.no_new_privs = false), but the daemon itself runs with no_new_privs, so they cannot`);
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
  readonly promptFiles: readonly string[];
  readonly #texts: TextsSource | undefined;

  constructor(dir: string, tools: CharacterTools = NO_USER, promptFiles: readonly string[] = [], texts?: TextsSource) {
    this.dir = dir;
    this.tools = tools;
    this.promptFiles = promptFiles;
    this.#texts = texts;
  }

  get texts(): Texts {
    try {
      return this.#texts === undefined ? new Texts() : Texts.of(this.#texts);
    } catch {
      return new Texts();
    }
  }

  get isolated(): boolean {
    return this.tools.user !== undefined;
  }

  at(dir: string): CharacterWorkspace {
    return dir === this.dir ? this : new CharacterWorkspace(dir, this.tools, [], this.#texts);
  }

  async user(): Promise<CharacterUser | undefined> {
    if (this.tools.user === undefined) return undefined;
    const user = await characterUser(this.tools.user);
    const problem = switchUserProblem(user);
    if (problem !== undefined) throw new CharacterUserError(problem);
    warnIfUnkillable(user);
    warnIfNoNewPrivsInherited(this.tools, user);
    return user;
  }

  async run(program: string, args: readonly string[], options: CharacterRunOptions = {}): Promise<ProcessOutput> {
    const launch = await this.#launch(program, args, options);
    return await runProcess(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdin: options.stdin, signal: options.signal, stopped: options.stopped, cut: this.texts.render("output_cut") });
  }

  async spawn(program: string, args: readonly string[], options: Pick<CharacterRunOptions, "cwd" | "env"> = {}): Promise<ChildProcessWithoutNullStreams> {
    const launch = await this.#launch(program, args, options);
    return spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  }

  async detach(program: string, args: readonly string[], options: Pick<CharacterRunOptions, "cwd" | "env"> = {}): Promise<ChildProcess> {
    const launch = await this.#launch(program, args, options);
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: "ignore", detached: true });
    child.unref();
    return child;
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
    return { command: setprivFor(env.PATH), args: [...setprivArgs(user, this.tools.noNewPrivs), "--", "env", `--chdir=${cwd}`, "--", program, ...args], cwd: "/", env };
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

export function workspaceTexts(workspace: string | CharacterWorkspace): Texts {
  return asCharacterWorkspace(workspace).texts;
}

export function closeWorkspaceHelpers(): void {
  for (const helper of helpers.values()) helper.close();
  helpers.clear();
}

interface CharacterSetup {
  tools: CharacterTools;
  promptFiles: readonly string[];
  texts: TextsSource;
}

const setupCache = new WeakMap<LoadedConfig, Map<string, CharacterSetup>>();

function setupOnDisk(config: LoadedConfig, name: string): CharacterSetup {
  const effective = loadCharacterConfig(config, name, () => {}) ?? config;
  const { tools, triggers, prompt } = effective.app;
  return { tools: toolsFrom(tools, triggers), promptFiles: promptWorkspaceFiles(prompt), texts: effective };
}

function characterSetup(config: LoadedConfig, name: string): CharacterSetup {
  let byName = setupCache.get(config);
  if (byName === undefined) {
    byName = new Map();
    setupCache.set(config, byName);
  }
  const cached = byName.get(name);
  if (cached !== undefined) return cached;
  const found = setupOnDisk(config, name);
  byName.set(name, found);
  return found;
}

export function characterToolsFor(config: LoadedConfig, name: string): CharacterTools {
  return characterSetup(config, name).tools;
}

export function characterWorkspace(config: LoadedConfig, name: string, options: { fresh?: boolean } = {}): CharacterWorkspace {
  const setup = options.fresh === true ? setupOnDisk(config, name) : characterSetup(config, name);
  return new CharacterWorkspace(
    characterWorkspaceDir(config.dirs.config, name, config.dirs.workspace),
    setup.tools,
    setup.promptFiles,
    setup.texts,
  );
}
