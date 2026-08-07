import compactPromptRaw from "../../../prompts/memory/compaction/compact.md" with { type: "text" };
import compactSystemRaw from "../../../prompts/memory/compaction/compact_system.md" with { type: "text" };

import { stripOneTrailingNewline } from "../../engine/prompt.ts";

export { stripOneTrailingNewline };

export const DEFAULT_COMPACT_SYSTEM: string = stripOneTrailingNewline(compactSystemRaw);

export const DEFAULT_COMPACT_PROMPT: string = stripOneTrailingNewline(compactPromptRaw);
