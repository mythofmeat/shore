import compactPromptRaw from "../../../prompts/memory/compaction/compact.md" with { type: "text" };

import { stripOneTrailingNewline } from "../../engine/prompt.ts";

export { stripOneTrailingNewline };

export const DEFAULT_COMPACT_PROMPT: string = stripOneTrailingNewline(compactPromptRaw);

const IF_DREAMING = "{{#if dreaming}}";

const END_IF = "{{/if}}";

export function withDreaming(template: string, dreaming: boolean): string {
  let out = "";
  let rest = template;
  for (;;) {
    const start = rest.indexOf(IF_DREAMING);
    const end = start < 0 ? -1 : rest.indexOf(END_IF, start + IF_DREAMING.length);
    if (end < 0) return out + rest;
    out += rest.slice(0, start) + (dreaming ? rest.slice(start + IF_DREAMING.length, end) : "");
    rest = rest.slice(end + END_IF.length);
  }
}
