import { resolve } from "node:path";

import { BASH_ARGS, bashEnvironment } from "../tools/bash.ts";
import type { CharacterWorkspace } from "../tools/character_workspace.ts";
import type { ProcessOutput } from "../tools/process.ts";

const OUTPUT_CHARS = 2000;

const ERROR_CHARS = 500;

export type CheckOutcome =
  | { kind: "quiet" }
  | { kind: "fired"; output: string }
  | { kind: "failed"; problem: string };

export interface CheckRun {
  workspace: CharacterWorkspace;
  character: string;
  trigger: string;
  command: string;
  facts: Readonly<Record<string, unknown>>;
  env: Readonly<Record<string, string>>;
  limitMs: number;
  signal?: AbortSignal | undefined;
}

function cut(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}… [cut]` : text;
}

export async function runCheck(run: CheckRun): Promise<CheckOutcome> {
  const root = resolve(run.workspace.dir);
  const limit = AbortSignal.timeout(run.limitMs);
  let output: ProcessOutput;
  try {
    output = await run.workspace.run("bash", [...BASH_ARGS, run.command], {
      cwd: root,
      env: { ...bashEnvironment(run.character, root, root), ...run.env, SHORE_TRIGGER: run.trigger },
      stdin: JSON.stringify(run.facts),
      signal: run.signal === undefined ? limit : AbortSignal.any([run.signal, limit]),
    });
  } catch (error) {
    if (run.signal?.aborted === true) throw error;
    if (limit.aborted) return { kind: "failed", problem: "it was still running at its time limit and was stopped" };
    return { kind: "failed", problem: `it could not be run: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (output.code !== 0) {
    const said = output.stderr.trim();
    return { kind: "failed", problem: `it exited with status ${String(output.code)}${said === "" ? "" : `: ${cut(said, ERROR_CHARS)}`}` };
  }
  const said = output.stdout.trim();
  return said === "" ? { kind: "quiet" } : { kind: "fired", output: cut(said, OUTPUT_CHARS) };
}
