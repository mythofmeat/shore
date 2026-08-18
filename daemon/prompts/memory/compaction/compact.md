The conversation above is now complete and will be archived once you finish. Review it, then call your `edit` tool to persist anything important.

Your workspace contains your existing memory files. Use `read` and `search` to check what's already there before writing, so you edit in place  where appropriate instead of creating near-duplicates.

Reminder:
- Prefer changing existing files (`edit` with `edits`) over creating new ones (`edit` with `content`), unless the file is over ~100 lines in length; if the file is ~100 lines, it should be split into smaller focused files instead.
- Batch your work: send several `edit` calls in one turn rather than one file per turn, and make all of a file's changes in a single `edit`. Don't re-open a file you already read this pass.
- Commit once at the very end, with `add` and `commit` in the same turn.
- End with a brief plain-text summary (no tool call) when you're done.
- Writing nothing is a valid outcome — the conversation is archived either way. Never pad memory just to have something to show.
