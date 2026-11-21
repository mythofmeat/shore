import { resolve } from "node:path";

import { spanPhrase } from "../autonomy/wake_shape.ts";
import { BASH_ARGS, bashEnvironment } from "./bash.ts";
import type { CharacterWorkspace } from "./character_workspace.ts";
import type { ProcessOutput } from "./process.ts";
import { byteSize, cutToBytes, MAX_THREAD_PIN_BYTES } from "./thread_file_text.ts";

function printed(output: ProcessOutput): string {
  const said = [output.stdout, output.stderr].map((text) => text.trimEnd()).filter((text) => text !== "").join("\n");
  const bytes = Buffer.byteLength(said, "utf8");
  return bytes <= MAX_THREAD_PIN_BYTES ? said : `${cutToBytes(said, MAX_THREAD_PIN_BYTES).trimEnd()}\n\n[Cut at ${byteSize(MAX_THREAD_PIN_BYTES)} of ${byteSize(bytes)}.]`;
}

function ending(output: ProcessOutput): string | undefined {
  if (output.code === null) return "(It was killed before it finished.)";
  return output.code === 0 ? undefined : `(Exited with status ${String(output.code)}.)`;
}

export async function pinnedCommandText(workspace: CharacterWorkspace, character: string, command: string): Promise<string> {
  const root = resolve(workspace.dir);
  const limit = AbortSignal.timeout(workspace.tools.checkLimitMs);
  let output: ProcessOutput;
  try {
    output = await workspace.run("bash", [...BASH_ARGS, command], { cwd: root, env: bashEnvironment(character, root, root), signal: limit });
  } catch (error) {
    if (limit.aborted) return `(Stopped at its time limit of ${spanPhrase(workspace.tools.checkLimitMs)}.)`;
    return `(It couldn't be run: ${error instanceof Error ? error.message : String(error)}.)`;
  }
  const said = printed(output);
  const end = ending(output);
  if (said === "") return end ?? "(The command printed nothing.)";
  return end === undefined ? said : `${said}\n\n${end}`;
}
