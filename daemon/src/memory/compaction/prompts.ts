import compactPromptRaw from "../../../prompts/memory/compaction/compact.md" with { type: "text" };

import { renderTemplate, stripOneTrailingNewline } from "../../engine/prompt.ts";

export { stripOneTrailingNewline };

export const DEFAULT_COMPACT_PROMPT: string = stripOneTrailingNewline(compactPromptRaw);

export function withDreaming(template: string, dreaming: boolean): string {
  return renderTemplate(template, new Map([["dreaming", dreaming ? "on" : ""]]));
}
