Read archived conversations with {{user}} in order, in local time. Give exactly one of:

- `around`: a message id from `search_chat_logs`. Shows that message, marked ▶, with the `before` and `after` messages around it in its thread (3 each by default).
- `start` and/or `end`: the messages in that range, oldest first, in one `thread` (default main). Long ranges come in pages; the result gives the next `offset`.
- `overview`: a date. Lists that day's conversations, split wherever 90 minutes passed without a message, with start and end times, message count and {{user}}'s first line. A conversation that crosses midnight shows its whole span.

Messages are never cut short: a result stops at about 12,000 characters, leaving out the messages farthest from what you asked for and saying how many. Gaps of 90 minutes or more are marked between messages.
