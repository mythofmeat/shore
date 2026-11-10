Schedule your next heartbeat, a private turn of your own time that runs without {{user}} prompting it.

`hours_from_now` counts from now and may be fractional. It is clamped to the configured minimum and maximum interval, and the result says how many hours were actually scheduled. A later call replaces the earlier schedule. {{#if wake_stays}}Messages from {{user}} don't move it.{{/if}}{{#if wake_defers}}Each message from {{user}}, and the end of each reply to one, pushes it to at least the minimum interval later.{{/if}}

{{#if wake_reason_shown}}`reason` is a note to yourself: that heartbeat shows it to you when it starts, so say what you want to do or check then. A later call replaces it along with the schedule. It is also recorded in the heartbeat log next to the scheduled time.{{/if}}{{#if wake_reason_logged}}`reason` is recorded in the heartbeat log next to the scheduled time. That heartbeat doesn't show it to you, so a note for it belongs in `HEARTBEAT.md`.{{/if}}
