import { resolve } from "node:path";

import { spanPhrase } from "../autonomy/wake_shape.ts";
import { BASH_ARGS, bashEnvironment } from "./bash.ts";
import type { CharacterWorkspace } from "./character_workspace.ts";
import type { ProcessOutput } from "./process.ts";
import { byteSize, cutToBytes, MAX_THREAD_PIN_BYTES } from "./thread_file_text.ts";
import type { Texts } from "../texts/texts.ts";

function printed(texts: Texts, output: ProcessOutput): string {
  const said = [output.stdout, output.stderr].map((text) => text.trimEnd()).filter((text) => text !== "").join("\n");
  const bytes = Buffer.byteLength(said, "utf8");
  if (bytes <= MAX_THREAD_PIN_BYTES) return said;
  const head = cutToBytes(said, MAX_THREAD_PIN_BYTES).trimEnd();
  const cut = texts.render("pin_output_cut", { limit: byteSize(MAX_THREAD_PIN_BYTES), total: byteSize(bytes) });
  return cut === undefined ? head : `${head}\n\n${cut}`;
}

function ending(texts: Texts, output: ProcessOutput): string | undefined {
  if (output.code === null) return texts.render("pin_killed");
  return output.code === 0 ? undefined : texts.render("pin_exit_status", { code: String(output.code) });
}

export async function pinnedCommandText(workspace: CharacterWorkspace, character: string, command: string): Promise<string> {
  const texts = workspace.texts;
  const root = resolve(workspace.dir);
  const limit = AbortSignal.timeout(workspace.tools.checkLimitMs);
  let output: ProcessOutput;
  try {
    output = await workspace.run("bash", [...BASH_ARGS, command], { cwd: root, env: bashEnvironment(character, root, root), signal: limit });
  } catch (error) {
    if (limit.aborted) return texts.render("pin_timed_out", { limit: spanPhrase(workspace.tools.checkLimitMs) }) ?? "";
    return texts.render("pin_not_run", { error: error instanceof Error ? error.message : String(error) }) ?? "";
  }
  const said = printed(texts, output);
  const end = ending(texts, output);
  if (said === "") return end ?? texts.render("pin_silent") ?? "";
  return end === undefined ? said : `${said}\n\n${end}`;
}
