/**
 * The two compaction prompt templates.
 *
 * What is left of `crates/daemon/src/memory/compaction/parser.rs` after the
 * dead half came out — see the deletion note below.
 *
 * The templates are read from the `prompts/` tree that already owns them
 * rather than copied into string literals, so there is one copy and it is the
 * one a person edits. `include_prompt!` strips exactly one trailing newline;
 * {@link stripOneTrailingNewline} is that rule, and it matters because these
 * strings are substituted into a request whose bytes are a cache prefix.
 *
 * # The XML parser is gone
 *
 * `parse_compaction_response`, `extract_write_ops` and `extract_xml_tag`
 * parsed a `<memory><write path="...">` payload out of the model's prose. They
 * had no caller left: the tool-loop redesign (the same change that introduced
 * the "no writes, no archive" guard) made memory writes arrive as `edit` tool
 * calls, and nothing has read the XML form since. The only thing still calling
 * those functions was their own unit tests. `MemoryFileOp` outlived them,
 * because the dry-run preview still describes an intended write with a path
 * and a body — it now comes from the tool call's arguments rather than from
 * parsed XML, and it lives in `types.ts` with the rest of the vocabulary.
 */

import compactPromptRaw from "../../../prompts/memory/compaction/compact.md" with { type: "text" };
import compactSystemRaw from "../../../prompts/memory/compaction/compact_system.md" with { type: "text" };

/**
 * Re-exported for the callers that already import it from here; the helper
 * itself lives in `engine/prompt.ts` now, beside the rest of the prompt-text
 * handling.
 */
import { stripOneTrailingNewline } from "../../engine/prompt.ts";

export { stripOneTrailingNewline };

/**
 * The compaction system prompt template.
 *
 * Placeholders: `{{char}}`, `{{user}}`. Carries only stable instructions — no
 * conversation, no memory snapshot — so it stays cacheable across passes for
 * the same character.
 */
export const DEFAULT_COMPACT_SYSTEM: string = stripOneTrailingNewline(compactSystemRaw);

/**
 * The compaction final-message template, appended as the last user turn.
 *
 * Placeholders: `{{char}}`, `{{user}}`.
 */
export const DEFAULT_COMPACT_PROMPT: string = stripOneTrailingNewline(compactPromptRaw);
