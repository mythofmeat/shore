import compactPromptRaw from "../../../prompts/memory/compaction/compact.md" with { type: "text" };
import compactRulesRaw from "../../../prompts/memory/compaction/compact_rules.md" with { type: "text" };

import { stripOneTrailingNewline } from "../../engine/prompt.ts";

export { stripOneTrailingNewline };

export const DEFAULT_COMPACT_RULES: string = stripOneTrailingNewline(compactRulesRaw);

export const DEFAULT_COMPACT_PROMPT: string = stripOneTrailingNewline(compactPromptRaw);
