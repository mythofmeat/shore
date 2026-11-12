# Triggers and checks

A trigger wakes you, or leaves you a diary entry, when something happens, without {{user}} prompting it. You set triggers up yourself in `TRIGGERS.toml`, in your workspace root. Shore looks at the file every half minute, so a change takes effect within a minute, and `{{list_triggers}}` shows what Shore made of it: when each trigger is next due, how often it has fired, and any that aren't running and why.

{{#if triggers_on}}{{user}} has triggers turned on.{{/if}}{{#if triggers_off}}{{user}} hasn't turned triggers on, so nothing in the file runs yet. It takes two of their settings: `enabled` under `[triggers]`, and `enabled` under `[heartbeat]`, which switches on your own time as a whole.{{/if}}

## The file

Each trigger is a table named for it. A name is letters, digits, dashes and underscores, starting with a letter or digit, at most 64 characters, with no dot in it.

```toml
[morning]
at = "08:30"
reason = "Start of the day: look over what is waiting."

[mail]
every = "30m"
check = "scripts/new-mail.sh"
cooldown = "2h"
between = "08:00-23:00"
```

A trigger says when it fires with exactly one of these:

- `every = "1h"`: again and again, that long apart, and at least a minute. The first time is that long after Shore first sees the trigger, and each later one counts from the time before.
- `at = "20:00"`: at that local time, on the 24-hour clock, every day. Days in front limit it: `at = "Sat 20:00"`, `at = "Mon,Thu 09:30"`. If Shore wasn't running then, it fires once, late.
- `on = "2026-11-12 00:00"`: once, at that local date and time, or late if Shore wasn't running then. One whose time had already passed when Shore first saw it never fires, so write a time a couple of minutes ahead.
- `when = "user_quiet"` with `after = "8h"`: once each time {{user}} has gone that long without writing to you.
- `when = "user_back"` with `after = "8h"`: as {{user}} writes to you again after at least that long. It never wakes you; see below.
- `when = "status_changed"`: when {{user}} sets or clears their status.
- `when = "dream_done"`: after one of your dreams.
- `follows = "another-trigger"`: after the trigger of that name in this file. See below for what it waits for.

`after` goes only with `user_quiet` and `user_back`, which both need it.

What it does when it fires:

- `reason = "..."` is what you are shown.
- `check = "command"` is run first, and the trigger fires only if the check prints something. What it printed is the reason, under the trigger's own `reason` if it has both. A trigger needs a `reason`, a `check`, or both.
- With nothing more, it wakes you in a heartbeat that starts with a line like `[Your trigger "mail" fired at ...: 2 new messages]`. Triggers that fire together share one heartbeat, and one that fires while a heartbeat is running is handed to that heartbeat before its next step. A heartbeat that has been told to wrap up is handed nothing new. A trigger that wasn't handed over, or that was shown in a step the heartbeat never answered, wakes you again once that heartbeat is over.
- `wake = false` leaves a diary entry in place of the wake. That costs no model call at all.
- `thread = "a-thread"` makes the wake run in that thread, with its conversation in front of you. `limit = "2h"` is how long that wake may run: at least a minute, {{default_wake_limit}} if you leave it out, and never more than {{max_wake_limit}}, which is {{user}}'s ceiling. `thread` only goes with a trigger that wakes you, and `limit` only goes with `thread`. It can be any thread of yours but the one your heartbeats run in: your home thread and a sealed thread both work. The `wakes` topic says how such a wake runs.

What holds it back:

- `cooldown = "6h"` is the least time between two firings of this trigger.
- `between = "10:00-03:00"` is the local hours it may fire in. The range may cross midnight.

Those are all the settings. Any other key stops that trigger from running, so that a typo can't turn a quiet check into a wake.

## Checks

A check is a command line run by `bash` in your workspace root, as the same user and with the same environment as your `{{bash}}` tool. No model is called, so a check that stays quiet costs nothing.

- It prints nothing and exits 0: the trigger stays quiet, and nothing is recorded.
- It prints something on stdout and exits 0: the trigger fires. What it printed is cut at {{check_output_chars}} characters.
- It exits with anything but 0: the check has failed, whatever it printed, and the trigger doesn't fire.
- It is still running after {{check_time_limit}}: it is stopped, and that counts as failed. {{user}} sets that limit. The check of a `user_back` trigger gets {{arrival_check_limit}}, because {{user}}'s reply waits on it.

Since any exit but 0 is a failure, write a test as an `if`. The short form `[ ... ] && echo ...` exits 1 whenever the test is false, and so fails every time it has nothing to say.

A check is handed what Shore knows, in its environment:

- `SHORE_TRIGGER`: the trigger's name.
- `SHORE_NOW`: the time now, in UTC, like `2026-11-12T07:30:00.000Z`.
- `SHORE_USER_LAST_MESSAGE_AT`: when {{user}} last wrote to you, in any thread, in the same form.
- `SHORE_USER_QUIET_SECS`: whole seconds since then.
- `SHORE_USER_LAST_SEEN_AT`: when {{user}} last wrote to you or last read a thread, in the same form.
- `SHORE_USER_STATUS`: {{user}}'s status, exactly as they set it.
- `SHORE_USER_STATUS_SET_AT`: when they set it, in the same form.

A variable Shore has nothing for is empty. `SHORE_USER_STATUS` and `SHORE_USER_STATUS_SET_AT` are both empty when {{user}} has cleared their status or never set one.{{#if statuses}} A status is always one from {{user}}'s own list, which is now: {{statuses}}.{{/if}}{{#if no_statuses}} {{user}}'s list of statuses is empty now, so they can't set one.{{/if}}

The same facts are on the check's stdin as one line of JSON, with `null` where a variable would be empty, along with figures on when {{user}} writes:

```json
{
  "now": "2026-11-12T07:30:00.000Z",
  "user": {
    "last_message_at": "2026-11-11T23:10:42.000Z",
    "quiet_secs": 29958,
    "last_seen_at": "2026-11-11T23:15:03.000Z",
    "status": "asleep",
    "status_set_at": "2026-11-11T23:16:00.000Z"
  },
  "activity": {
    "messages": 4210,
    "share_of_messages_by_local_hour": [0.01, 0, 0, 0, 0, 0, 0.02, 0.05, 0.06, 0.05, 0.04, 0.05, 0.06, 0.05, 0.04, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.08, 0.06, 0.04],
    "median_secs_between_sessions": 5400
  }
}
```

`messages` is how many of {{user}}'s messages are on record, the same figure `{{activity_heatmap}}` gives as its total: those from the 90 days before Shore last started, and every one since. `share_of_messages_by_local_hour` is the share of them written in each local hour, from midnight on, and `median_secs_between_sessions` is the middle gap between their recent sittings, or `null` when there aren't two to compare. `activity` is `null` when Shore has no record for you.

This trigger wakes you when {{user}} sets one particular status, and stays quiet for any other and for a cleared one:

```toml
[gone-to-bed]
when = "status_changed"
check = 'if [ "$SHORE_USER_STATUS" = "asleep" ]; then echo "They have gone to bed."; fi'
```

## Cooldowns and hours

A trigger that wakes you has a cooldown of {{wake_cooldown}} unless it sets its own. {{user}} chooses that default. A trigger with `wake = false`, a `user_back` one and a one-off have none unless they set one.

A trigger that comes due during its cooldown is not lost. It waits, its check isn't run meanwhile, and its turn comes when the cooldown ends. The same holds for a trigger waiting on a dream, a status change or another trigger: what happened is remembered until the cooldown is over.

A trigger that comes due outside its `between` hours is skipped, not held until they open.

## One-offs

A trigger with `on` fires once. After that it stays in the file, and `{{list_triggers}}` goes on showing it, as fired and with no next time. It does nothing more there, so take it out whenever you like. Writing a later time in its place arms it again.

A one-off gets no second try, so a check that fails is handled differently: see the end of this page.

## `user_back`

A `user_back` trigger never wakes you, because you are already answering {{user}}. What it says, its `reason` or what its check printed, arrives with their message as a diary entry from that trigger, above what they wrote. Setting `wake` on it is an error, and no trigger can follow it. One that comes up during its cooldown or outside its hours is skipped for that return.

## `follows`

A follower waits for the trigger it names to fire. If that trigger left a diary entry, the follower's turn comes at Shore's next look, within a minute. If that trigger woke you, the follower's turn comes once that wake is over, whether the wake was started for it or it was handed to one already running. A trigger whose check stayed quiet hasn't fired, so it sets off no follower. A trigger can't follow itself, a trigger that isn't running, a `user_back` trigger, or a ring of triggers that follow each other.

## The diary entries

A trigger with `wake = false` leaves an entry marked as from that trigger. The diary keeps only the newest entry from each trigger, so one that fires often replaces its own last entry and can't crowd out the rest.

## While you are dormant

Triggers and checks stop while you are dormant. Nothing fires, no check runs, and what comes due then is passed over, not saved up. A `user_back` trigger still works, since {{user}} writing is what ends dormancy. The `wakes` topic says when you go dormant.

## When something is wrong

- A file that isn't valid TOML runs none of its triggers. A single trigger that doesn't make sense is left out and the rest run.
- You are told in a diary entry from Shore which triggers aren't running and why, once, and again when what is wrong changes. `{{list_triggers}}` lists them too.
- A check that fails gets you one diary entry from Shore saying how: its exit status with the first {{check_error_chars}} characters of what it wrote on stderr, or that it ran out of time. The check keeps being tried each time the trigger comes due, and you are told again only once it has worked and then failed again.
- A one-off whose check fails isn't tried again. If it was to wake you, it wakes you anyway, and the wake says that the check failed and how. If it was only to leave an entry, the diary entry from Shore says that nothing will come of it.
- `{{list_triggers}}` says of each check when it last ran and whether it printed nothing or failed, so a check that is quiet can be told from one that isn't running.
- A trigger whose `thread` isn't a thread of yours, or is the one your heartbeats run in, wakes nothing, and a diary entry from Shore says so.
- {{user}} can switch a single trigger off by name. `{{list_triggers}}` marks it, and it neither fires nor runs its check until they switch it back on.
