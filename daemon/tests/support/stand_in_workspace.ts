import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CharacterWorkspace, type CharacterRunOptions } from "../../src/tools/character_workspace.ts";
import type { CharacterUser } from "../../src/tools/character_user.ts";
import type { OpArgs, OpResult, WorkspaceOp } from "../../src/tools/workspace_ops.ts";

export class StandInWorkspace extends CharacterWorkspace {
  readonly #direct: CharacterWorkspace;
  readonly #home: string;
  readonly calls: string[] = [];

  constructor(dir: string, home: string) {
    super(dir, { user: "stand-in", passEnv: [], noNewPrivs: true });
    this.#direct = new CharacterWorkspace(dir);
    this.#home = home;
  }

  override user(): Promise<CharacterUser> {
    return Promise.resolve({ spec: "stand-in", uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, name: "stand-in", home: this.#home, shell: undefined });
  }

  override async call<K extends WorkspaceOp>(op: K, args: OpArgs<K>, signal?: AbortSignal): Promise<OpResult<K>> {
    this.calls.push(op);
    return await this.#direct.call(op, args, signal);
  }

  override async spawn(program: string, args: readonly string[], options: Pick<CharacterRunOptions, "cwd" | "env"> = {}): Promise<ChildProcessWithoutNullStreams> {
    return await this.#direct.spawn(program, args, options);
  }
}
