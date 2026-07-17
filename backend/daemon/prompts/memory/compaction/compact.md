The conversation above is now complete and will be archived once you finish writing memory. Review it, then call your `edit` tool to persist anything important.

Your `MEMORY.md` index (already in your system prompt) maps your existing memory files. Use `read` and `search` to check what's already there before writing, so you edit in place instead of creating near-duplicates.

Reminder:
- Prefer changing existing files (`edit` with `edits`) over creating new ones (`edit` with `content`), unless the file is somewhat long (over 100 lines). If the file is long, then it should be split into focused files instead.
- End with a brief plain-text summary (no tool call) when you're done.
- If you produce zero writes, the conversation will NOT be archived and the next compaction trigger will retry.
