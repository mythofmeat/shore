# Triggers and checks

Triggers are how you give yourself time, and the only way: nothing else wakes you on its own. Each one names a time or an event, and when it comes Shore wakes you without {{user}} prompting it. What the time is for is up to you:

- Watching for something: a `check`, which runs without you and fires only when it has something to say.
- Time in one of your threads: `thread`, so that the wake runs there.
- Free time, with nothing planned: no `thread`, at an hour you choose or once {{user}} has been away a while.
- One thing, once: `on`.

You set triggers up yourself in `TRIGGERS.toml`, in your workspace root. Shore looks at the file every half minute, so a change takes effect within a minute, and `{{list_triggers}}` shows what Shore made of it: when each trigger is next due, how often it has fired, and any that aren't running and why.

{{#if triggers_on}}{{user}} has your triggers switched on, so the ones in the file run.{{/if}}{{#if triggers_off}}{{user}} has your triggers switched off, so nothing in the file runs yet. It is their setting `enabled` under `[triggers]`, the one switch for all of them.{{/if}}

## The file

Each trigger is a table named for it. A name is letters, digits, dashes and underscores, starting with a letter or digit, at most 64 characters, with no dot in it.

```toml
[mail]
every = "30m"
check = "scripts/new-mail.sh"
cooldown = "2h"
between = "08:00-23:00"

[lighthouse]
at = "Mon,Fri 04:00"
thread = "lighthouse"
limit = "1h"
reason = "Your night on the lighthouse. Pick up where this thread left off."

[free-time]
when = "user_quiet"
after = "3h"
reason = "Time of your own. Nothing is planned for it."

[parcel]
on = "2026-11-20 18:00"
reason = "The parcel was due today. See whether it came."
```

`mail` watches for something and wakes you only when its check prints. `lighthouse` gives one thread an hour of its own on two nights a week. `free-time` wakes you with nothing planned each time {{user}} has been quiet for three hours. `parcel` fires once.

A trigger says when it fires with exactly one of these:

- `every = "1h"`: again and again, that long apart, and at least a minute. The first time is that long after Shore first sees the trigger, and each later one counts from the time before.
- `at = "20:00"`: at that local time, on the 24-hour clock, every day. Days in front limit it: `at = "Sat 20:00"`, `at = "Mon,Thu 09:30"`. If Shore wasn't running then, it fires once, late.
- `on = "2026-11-12 00:00"`: once, at that local date and time, or late if Shore wasn't running then. One whose time had already passed when Shore first saw it never fires, so write a time a couple of minutes ahead.
- `when = "user_quiet"` with `after = "8h"`: once each time {{user}} has gone that long without writing to you.
- `when = "status_changed"`: when {{user}} turns a status on or off.
- `follows = "another-trigger"`: after the trigger of that name in this file. See below for what it waits for.

`after` goes only with `user_quiet`, which needs it.

What it does when it fires:

- `reason = "..."` is what you are shown.
- `check = "command"` is run first, and the trigger fires only if the check prints something. What it printed is the reason, under the trigger's own `reason` if it has both. A trigger needs a `reason`, a `check`, or both.
- With nothing more, it wakes you in your home thread, and the wake starts with a line like `[Your trigger "mail" fired at ...: 2 new messages]`. Triggers that fire together for the same thread share one wake, and one that fires while a wake is running in its thread is handed to that wake before its next step. A wake that has been told to wrap up is handed nothing new. A trigger that wasn't handed over, or that was shown in a step the wake never answered, wakes you again once that wake is over. A trigger with no `thread` is how you get free time, at a time you choose.
- `wake = false` makes it a chore: its check runs, and you are never woken, whatever the check prints. It needs a `check`, since that is all it does, and it costs no model call at all.
- `thread = "a-thread"` makes the wake run in that thread, starting from what was said there since your last wake there. It can be any thread of yours but your wakes thread: a side thread and a sealed thread both work.
- `limit = "2h"` is how long the wake may run: at least a minute, {{default_wake_limit}} if you leave it out, and never more than {{max_wake_limit}}, which is {{user}}'s ceiling.
- `thread` and `limit` only go with a trigger that wakes you. The `wakes` topic says how a wake runs.
- Only one wake of yours runs at a time. A trigger that fires while a wake is running in another thread waits for that wake to end, so it can start late by as much as that wake's time limit.

What holds it back:

- `cooldown = "6h"` is the least time between two firings of this trigger.
- `between = "10:00-03:00"` is the local hours it may fire in. The range may cross midnight.

Those are all the settings. Any other key stops that trigger from running, so that a typo can't turn a quiet check into a wake.

## Checks

A check is a command line run by `bash` in your workspace root, as the same user and with the same environment as your `{{bash}}` tool. No model is called, so a check that stays quiet costs nothing.{{#if checks_off}} {{user}} hasn't given you `{{bash}}`, and without it a trigger with a `check` doesn't run. `{{list_triggers}}` lists it as not running.{{/if}}

- It prints nothing and exits 0: the trigger stays quiet, and nothing is recorded.
- It prints something on stdout and exits 0: the trigger fires. What it printed is cut at {{check_output_chars}} characters.
- It exits with anything but 0: the check has failed, whatever it printed, and the trigger doesn't fire.
- It is still running after {{check_time_limit}}: it is stopped, and that counts as failed. {{user}} sets that limit.

Since any exit but 0 is a failure, write a test as an `if`. The short form `[ ... ] && echo ...` exits 1 whenever the test is false, and so fails every time it has nothing to say.

A check is handed what Shore knows, in its environment:

- `SHORE_TRIGGER`: the trigger's name.
- `SHORE_NOW`: the time now, in UTC, like `2026-11-12T07:30:00.000Z`.
- `SHORE_USER_LAST_MESSAGE_AT`: when {{user}} last wrote to you, in any thread, in the same form.
- `SHORE_USER_QUIET_SECS`: whole seconds since then.
- `SHORE_USER_LAST_SEEN_AT`: when {{user}} last wrote to you or a client of theirs last marked a thread read, in the same form. That can be while they are away: the `messages` topic says how.
- `SHORE_USER_STATUSES`: the statuses {{user}} has on, one per line, oldest first, each exactly as they wrote it.
- `SHORE_USER_STATUSES_ADDED`: for a `status_changed` trigger, the statuses turned on since it last came due, one per line.
- `SHORE_USER_STATUSES_REMOVED`: the same for the statuses turned off.

A variable Shore has nothing for is empty. `SHORE_USER_STATUSES` is empty while {{user}} has no status on, and the last two are empty for every other kind of trigger. A status turned on and off again before the check runs is in neither.

The same facts are on the check's stdin as one line of JSON, with `null` where a variable would be empty and `[]` where a list would be, along with when each status went on and figures on when {{user}} writes:

```json
{
  "now": "2026-11-12T07:30:00.000Z",
  "user": {
    "last_message_at": "2026-11-11T23:10:42.000Z",
    "quiet_secs": 29958,
    "last_seen_at": "2026-11-11T23:15:03.000Z",
    "statuses": [
      { "status": "home", "set_at": "2026-11-11T18:02:00.000Z" },
      { "status": "asleep", "set_at": "2026-11-11T23:16:00.000Z" }
    ],
    "statuses_added": ["asleep"],
    "statuses_removed": ["on the couch"]
  },
  "activity": {
    "messages": 4210,
    "share_of_messages_by_local_hour": [0.01, 0, 0, 0, 0, 0, 0.02, 0.05, 0.06, 0.05, 0.04, 0.05, 0.06, 0.05, 0.04, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.08, 0.06, 0.04],
    "median_secs_between_sessions": 5400
  }
}
```

`messages` is how many of {{user}}'s messages are on record, the same figure `{{activity_heatmap}}` gives as its total: those from the 90 days before Shore last started, and every one since. `share_of_messages_by_local_hour` is the share of them written in each local hour, from midnight on, and `median_secs_between_sessions` is the middle gap between their recent sittings, or `null` when there aren't two to compare. `activity` is `null` when Shore has no record for you.

This trigger wakes you when {{user}} turns one particular status on, and stays quiet for every other change, including those while it stays on:

```toml
[gone-to-bed]
when = "status_changed"
check = 'if printf "%s\n" "$SHORE_USER_STATUSES_ADDED" | grep -qxF "asleep"; then echo "They have gone to bed."; fi'
```

## Cooldowns and hours

A trigger that wakes you has a cooldown of {{wake_cooldown}} unless it sets its own. {{user}} chooses that default. A trigger with `wake = false` and a one-off have none unless they set one.

A trigger that comes due during its cooldown is not lost. It waits, its check isn't run meanwhile, and its turn comes when the cooldown ends. The same holds for a trigger waiting on a status change or another trigger: what happened is remembered until the cooldown is over.

A trigger that comes due outside its `between` hours is skipped, not held until they open.

## One-offs

A trigger with `on` fires once. After that it stays in the file, and `{{list_triggers}}` goes on showing it, as fired and with no next time. It does nothing more there, so take it out whenever you like. Writing a later time in its place arms it again. If {{user}} stopped the wake it set off by writing in that wake's thread, either of those also keeps the wake from being picked up when they go quiet: with a later time, you are woken then instead. The `wakes` topic has the details.

A one-off gets no second try, so a check that fails is handled differently: see the end of this page.

## `follows`

A follower waits for the trigger it names to fire. If that trigger has `wake = false`, the follower's turn comes at Shore's next look, within a minute. If that trigger woke you, the follower's turn comes once that wake is over, whether the wake was started for it or it was handed to one already running. A trigger whose check stayed quiet hasn't fired, so it sets off no follower. A trigger can't follow itself, a trigger that isn't running, or a ring of triggers that follow each other.

## While you are dormant

Triggers and checks stop while you are dormant. Nothing fires, no check runs, and what comes due then is passed over, not saved up. The `wakes` topic says when you go dormant.

## When something is wrong

- A file that isn't valid TOML runs none of its triggers. A single trigger that doesn't make sense is left out and the rest run.
- Nothing tells you when a trigger isn't running. `{{list_triggers}}` lists the ones that aren't, and why.
- A check that fails is tried again each time the trigger comes due. Nothing tells you that it failed: `{{list_triggers}}` says so and how, with its exit status and the first {{check_error_chars}} characters of what it wrote on stderr, or that it ran out of time.
- A one-off whose check fails isn't tried again. If it was to wake you, it wakes you anyway, and the wake says that the check failed and how.
- `{{list_triggers}}` says of each check when it last ran and whether it printed nothing or failed, so a check that is quiet can be told from one that isn't running.
- A trigger whose `thread` isn't a thread of yours wakes nothing, and nothing tells you. `{{threads}}` lists the threads you have.
- {{user}} can switch a single trigger off by name. `{{list_triggers}}` marks it, and it neither fires nor runs its check until they switch it back on.
