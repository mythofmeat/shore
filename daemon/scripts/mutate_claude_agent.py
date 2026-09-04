#!/usr/bin/env python3
"""Mutation pass over what the Agent SDK provider considers "the same message".

The Agent SDK owns conversation history; shore only remembers a hash per message
so it can tell, next turn, whether the incoming history still extends what the
session was given. Everything downstream rests on that comparison: an exact
prefix resumes the session, a divergence forks it at an assistant uuid, and no
common prefix cold starts and replays the whole conversation as text.

So a hash that is too coarse does not throw — it silently claims two different
conversations are one. The original hash was taken over text blocks only, which
meant a turn was identified by its words and nothing else: two messages differing
only by the image attached were the same message, and once tool calls exist, an
assistant turn is identified by prose it may not even have.

That is the shape of every mutant in the first group. Each removes one field from
the fingerprint, and the evidence a test can hold is only that two messages
differing in exactly that field stay told apart.

The whitespace mutant is the subtle one. A block list is hashed twice at
different moments — once when the turn is recorded, once when it comes back on
the wire — and `handler/wire_messages.ts` drops whitespace-only text blocks in
between. Hashing without the same filter makes the two disagree, and the symptom
is not a wrong answer but an unexplained cold start.

The version mutants guard the upgrade itself: a book written under the old hash
must not be read under the new one, because its entries would never match and
the mismatch would look like a divergence rather than a stale book.

A mutant is KILLED if `bun test tests/claude_agent_sessions.test.ts` fails with
it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_claude_agent.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
AGENT = "src/llm/providers/claude_agent.ts"
SESSIONS = "src/llm/providers/agent_sessions.ts"

TESTS = ["tests/claude_agent_sessions.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- what identifies a message -------------------------------------------
    ("hash: an image contributes nothing, so two different pictures are one turn",
     AGENT,
     "      return `image:${block.source.media_type}:${digest(block.source.data)}`;",
     "      return `image:${block.source.media_type}`;"),
    ("hash: the image's type is dropped, so a png and a jpeg of it are one turn",
     AGENT,
     "      return `image:${block.source.media_type}:${digest(block.source.data)}`;",
     "      return `image:${digest(block.source.data)}`;"),
    ("hash: a tool call is identified by its name alone, whatever it was asked to do",
     AGENT,
     "      return `tool_use:${block.id}:${block.name}:${canonicalJson(block.input)}`;",
     "      return `tool_use:${block.id}:${block.name}`;"),
    ("hash: a tool result is identified by which call it answers, not by what it said",
     AGENT,
     "      return `tool_result:${block.tool_use_id}:${block.is_error === true ? \"1\" : \"0\"}:${digest(body)}`;",
     "      return `tool_result:${block.tool_use_id}:${digest(body)}`;"),
    ("hash: a failed tool call reads the same as one that succeeded",
     AGENT,
     "      return `tool_result:${block.tool_use_id}:${block.is_error === true ? \"1\" : \"0\"}:${digest(body)}`;",
     "      return `tool_result:${block.tool_use_id}:${block.is_error === true ? \"1\" : \"0\"}`;"),
    ("hash: the role is dropped, so a question and its echo back are one message",
     AGENT,
     "  return digest([msg.role, ...hashableBlocks(msg).map(blockFingerprint)].join(SESSION_KEY_SEPARATOR));",
     "  return digest(hashableBlocks(msg).map(blockFingerprint).join(SESSION_KEY_SEPARATOR));"),
    ("hash: only the first block counts, so anything after the caption is invisible",
     AGENT,
     "  return digest([msg.role, ...hashableBlocks(msg).map(blockFingerprint)].join(SESSION_KEY_SEPARATOR));",
     "  return digest([msg.role, hashableBlocks(msg).map(blockFingerprint)[0] ?? \"\"].join(SESSION_KEY_SEPARATOR));"),

    # --- the same arguments written two ways ---------------------------------
    ("canonical: object keys keep their insertion order, so re-serialising a call diverges",
     AGENT,
     "  const entries = Object.entries(value as Record<string, unknown>)\n"
     "    .filter(([, v]) => v !== undefined)\n"
     "    .sort(([a], [b]) => compareByCodePoint(a, b));",
     "  const entries = Object.entries(value as Record<string, unknown>)\n"
     "    .filter(([, v]) => v !== undefined);"),

    # --- recording and replay must agree -------------------------------------
    ("whitespace: a blank text block is hashed, so recording and replay disagree",
     AGENT,
     "  return msg.content.filter((b) => !(b.type === \"text\" && b.text.trim() === \"\"));",
     "  return [...msg.content];"),

    # --- a book from before the hash changed ---------------------------------
    ("version: a book written under the old hash is read as if it were current",
     AGENT,
     "  if (record === undefined || record.version !== SESSION_BOOK_VERSION) return coldStart(msgs);",
     "  if (record === undefined) return coldStart(msgs);"),
    ("version: any version is accepted as long as one is present",
     AGENT,
     "  if (record === undefined || record.version !== SESSION_BOOK_VERSION) return coldStart(msgs);",
     "  if (record === undefined || record.version === undefined) return coldStart(msgs);"),
    ("version: the book is stamped with the version it is not",
     SESSIONS,
     "export const SESSION_BOOK_VERSION = 2;",
     "export const SESSION_BOOK_VERSION = 1;"),

    # --- what a text-only replay says about the rest -------------------------
    ("replay: an image-only turn is dropped again, so the history skips it in silence",
     AGENT,
     "      if (block.type === \"image\") {\n"
     "        return omissionNotice(block.source.media_type, \"this provider replays history as text\");\n"
     "      }",
     ""),
]

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
