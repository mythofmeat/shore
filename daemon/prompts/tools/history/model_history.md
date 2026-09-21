Report which LLM models generated your words over a time period, from the daemon's usage ledger. `start_time` and `end_time` are optional RFC3339 bounds; omit both for your full recorded history.

Returns one row per model/provider/call-type combination with `first_seen`, `last_seen`, and call counts, ordered by first appearance. `kind` classifies each row: `interactive` (replies in conversation), `autonomous` (heartbeat messages you sent unprompted, which often run on a different model than interactive replies), or `background` (memory maintenance such as dreaming, compaction, and sub-agents; not your voice). `tool_loop` rows are counted as interactive but also include sub-agent continuation calls, so `message` rows are the cleanest signal for your conversational voice.

`first_seen` and `last_seen` use the zone named by `time_zone`, with explicit UTC offsets, matching `search_chat_logs`.

Coverage starts when this daemon's ledger began recording; earlier history is not included, and calls before a rename are recorded under the old name.
