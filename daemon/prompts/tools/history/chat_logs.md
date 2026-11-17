Your conversations with {{user}} in every thread, archived or not: your messages, {{user}}'s, and what you sent from your wakes, never thinking or tool calls. Only this thread's messages that are still in your context are left out. What you wrote while working in a wake is kept in your wakes thread, and `search` and `overview` leave that thread out: to search it or read it, set `thread` to its id. `action` is `search`, to find messages by the words that were said, or `read`, to read conversations in order.

`search`: `query` is SQLite FTS5 syntax: words that must all appear (`lemon tart`), `"an exact phrase"`, `OR`, `NOT`, a prefix (`bake*` finds bake, baked, baking) and `NEAR(lemon tart, 10)`. If it isn't valid FTS5, each word is searched as written and the result says so. `match: "substring"` finds the text anywhere, inside words too, for partial words, typos and writing without spaces.

Without `start` or `end`, only the last 6 months are searched, and the count says how many older matches there are; `all_time: true` searches everything. The result gives the total count and one line per hit: local time, speaker, thread when it isn't main, a snippet with the match in [brackets], and the message id. A snippet is only the few words around the match, on one line, with … wherever the message goes on, so it is never the whole message. Pass the id to `read` as `around` to read the whole message and the conversation there.

`read`: times are local. Give exactly one of:

- `around`: a message id from `search`. Shows that message, marked ▶, with the `before` and `after` messages around it in its thread (3 each by default).
- `start` and/or `end`: the messages in that range, oldest first, in one `thread` (default main). Long ranges come in pages; the result gives the next `offset`.
- `overview`: a date. Lists that day's conversations, split wherever 90 minutes passed without a message, with start and end times, message count and {{user}}'s first line. A conversation that crosses midnight shows its whole span.

Messages are never cut short: a result stops at about 12,000 characters, leaving out the messages farthest from what you asked for and saying how many. Gaps of 90 minutes or more are marked between messages.
