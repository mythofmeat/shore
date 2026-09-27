Schedule your next heartbeat, a private turn of your own time that runs without {{user}} prompting it.

`hours_from_now` counts from now and may be fractional. It is clamped to the configured minimum and maximum interval, and the result says how many hours were actually scheduled. A later call replaces the earlier schedule. If {{user}} messages you before then, the heartbeat waits at least the minimum interval after their message.

`reason` is recorded in the heartbeat log next to the scheduled time.
