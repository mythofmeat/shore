#!/usr/bin/env python3
"""Exercise the chat transcript, markdown safety, themes, shortcuts, settings wording and the parity ratchet."""
import sys
from mutation import run

T = "src/browser/chat/transcript.ts"
W = "src/browser/workspace.ts"
M = "src/browser/markdown.tsx"
H = "src/browser/theme.ts"
S = "src/browser/app/shortcuts.ts"
F = "src/browser/settings/format.ts"
P = "scripts/browser_parity.ts"
MUTANTS = [
    ("context boundary shown at the first message", T, 'index === activeStart && index > 0', 'index === activeStart'),
    ("every assistant reply treated as last", T, 'last: index === lastAssistant', 'last: message.role === "assistant"'),
    ("day dividers repeat for every message", T, 'if (key !== previousDay) {', 'if (true) {'),
    ("tool results create duplicate chips", T, 'if (view === undefined) views.push', 'if (true) views.push'),
    ("tool errors reported as success", T, 'view.error = block.is_error === true;', 'view.error = false;'),
    ("blank text blocks rendered", T, 'if (block.text.trim() !== "") views.push', 'views.push'),
    ("swipe count off by one", T, 'Math.max(1, (message.alt_index ?? count - 1) + 1)', 'Math.max(1, message.alt_index ?? count - 1)'),
    ("previous swipe allowed on the first response", T, 'canPrevious: position > 1', 'canPrevious: position > 0'),
    ("finished streams from other requests reappear", T, 'stream.rid !== null && active.has(stream.rid)', 'true'),
    ("finished stream shown alongside its message", T, '!messages.some((message) => message.msg_id === stream.msgId) && stream.rid', 'stream.rid'),
    ("every step gets its own box", T, 'else if (last?.kind === "activity") last.steps.push(view);', 'else if (false) last.steps.push(view);'),
    ("a finished reply still says Thinking", T, 'if (live && latest?.kind === "thinking")', 'if (latest?.kind === "thinking")'),
    ("a finished reply names its last tool instead of summarising", T, 'if (live && latest?.kind === "tool" && latest.output === null)', 'if (latest?.kind === "tool" && latest.output === null)'),
    ("a running tool is summarised instead of named", T, 'if (live && latest?.kind === "tool" && latest.output === null)', 'if (false)'),
    ("the summary ignores reasoning", T, 'steps.some((step) => step.kind === "thinking") ? `Reasoned and used ${count}` : `Used ${count}`', '`Used ${count}`'),
    ("long tool lists are not shortened", T, 'names.length > 3 ?', 'false ?'),
    ("a reply's saved rounds are not recognised by their tool calls", T, 'const shared = toolUseIds(last.content_blocks).some((id) => stream.tools.includes(id));', 'const shared = false;'),
    ("a round saved before its tool calls arrive is not recognised", T, 'const awaitingTools = stream.tools.length === 0 && ', 'const awaitingTools = false && '),
    ("an earlier reply ending in a tool call is claimed", T, 'const awaitingTools = stream.tools.length === 0 && ', 'const awaitingTools = '),
    ("saved tool calls repeat in the live reply", T, '? !ids.includes(block.id) :', '? true :'),
    ("a live result replaces the saved one", T, 'block.type === "tool_result" && !answered.has(block.tool_use_id)', 'block.type === "tool_result"'),
    ("a round saved after its tool calls arrived shows twice", T, '(stream.round.tools.includes(latest) || !stream.tools.includes(latest))', '!stream.tools.includes(latest)'),
    ("a round saved before its tool calls arrived shows twice", T, '(stream.round.tools.includes(latest) || !stream.tools.includes(latest))', 'stream.round.tools.includes(latest)'),
    ("earlier rounds vanish before any are saved", T, 'const unsaved = saved === undefined ? stream :', 'const unsaved = saved === undefined ? stream.round :'),
    ("empty reasoning makes an empty reply look started", T, 'unsaved.reasoning === "" ? [] :', 'false ? [] :'),
    ("empty text makes an empty reply look started", T, 'unsaved.text === "" ? [] :', 'false ? [] :'),
    ("a new model call keeps the previous round's text", W, 'const round = next.round.tools.length > 0 ? { reasoning: "", text: "", tools: [] } : next.round;', 'const round = next.round;'),
    ("the current round drops its reasoning", W, '{ ...round, reasoning: round.reasoning + message.text }', '{ ...round }'),
    ("the current round drops its text", W, '{ ...round, text: round.text + message.text }', '{ ...round }'),
    ("tool calls are not remembered for the reply", W, 'next.tools = [...next.tools, message.tool_id];', ''),
    ("tool calls are not remembered for the current round", W, 'next.round = { ...next.round, tools: [...next.round.tools, message.tool_id] };', ''),
    ("compaction notice survives its request", T, 'if (phase === null || phase.id < finished) return null;', 'if (phase === null) return null;'),
    ("tool summary shows raw objects", T, 'values.find((value): value is string => typeof value === "string" && value.trim() !== "")', 'values.find((value): value is string => value !== undefined)'),
    ("unsafe link schemes become clickable", M, 'const SAFE_LINK = /^(https?:|mailto:)/i;', 'const SAFE_LINK = /^/i;'),
    ("raw HTML rendered as markup", M, 'case "html": return node.value;', 'case "html": return <span key={key} dangerouslySetInnerHTML={{ __html: node.value }} />;'),
    ("unknown stored theme accepted", H, 'return isThemeId(value) ? value : DEFAULT_THEME;', 'return (value ?? DEFAULT_THEME) as ThemeId;'),
    ("failed theme save reported as saved", H, 'error = "This browser couldn\'t save the theme, so it will reset on reload.";', 'error = "";'),
    ("theme changes from other tabs ignored", H, 'if (theme !== this.#theme) this.#set(theme, "");', ''),
    ("help shortcut fires while typing", S, 'if (!typing && !mod && !event.altKey && event.key === "?") return "help";', 'if (!mod && !event.altKey && event.key === "?") return "help";'),
    ("palette ignores the modifier", S, 'if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") return "palette";', 'if (event.key.toLowerCase() === "k") return "palette";'),
    ("palette matches any word instead of every word", S, 'return words.every((word) => text.includes(word)) ? [index] : [];', 'return words.length === 0 || words.some((word) => text.includes(word)) ? [index] : [];'),
    ("conversation cycling stops at the end", S, 'return items[(index + step + items.length) % items.length];', 'return items[index + step];'),
    ("key=value lines truncated at later equals signs", F, 'pairs[line.slice(0, index).trim()] = line.slice(index + 1);', 'pairs[line.slice(0, index).trim()] = line.slice(index + 1).split("=")[0] ?? "";'),
    ("lines without a key accepted", F, 'if (index <= 0) throw', 'if (index < 0) throw'),
    ("uncertain requests look safe", F, 'Check the affected conversation or setting before trying again.", tone: "bad" };', 'Check the affected conversation or setting before trying again.", tone: "ok" };'),
    ("stale known gaps tolerated", P, 'if (stale.length > 0) throw', 'if (false) throw'),
    ("new gaps tolerated", P, 'if (unlisted.length > 0) throw', 'if (false) throw'),
    ("surfaces allowed at a less accessible tier", P, 'TIERS.indexOf(tier) > TIERS.indexOf(unit.tier)', 'false'),
    ("misspelled surfaces accepted", P, 'if (!referenced.has(key)) throw', 'if (false) throw'),
    ("partial field coverage counted as covered", P, 'if (tier === undefined) { covered = false; continue; }', 'if (tier === undefined) continue;'),
    ("removed terminal routes linger", P, 'if (!seen.has(path)) throw', 'if (false) throw'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_chat.test.ts", "tests/browser_workspace.test.ts", "tests/browser_settings.test.ts", "tests/browser_parity.test.ts"]))
