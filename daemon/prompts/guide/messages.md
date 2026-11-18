# Messages, pushes and {{user}}'s status

## Messages

In a conversation your reply is the message. From a wake nothing reaches {{user}} unless you send it with `{{send_message}}`:

- `text` is what to say. It is posted in the thread the wake ran in, which is your home thread when its trigger names no thread, or in the thread that `thread` names.
- It is delivered when the wake ends, and each call is a message of its own.
- A wake's final response isn't sent. It stays in the wake's working.
- A wake stopped at its limit still delivers what it had sent by then. One that {{user}} stopped by writing in its thread delivers nothing: it is picked up again later, and is told that nothing was sent.

From a conversation `{{send_message}}` is only for saying something in another thread, so it needs `thread`. It is delivered once your reply is done, and not at all if the reply fails or {{user}} stops it.

It is refused, with the reason, for a thread you don't have, for your wakes thread, and for a sealed thread you aren't in. A wake in a sealed thread sends only inside it.

A picture or a video from your workspace goes in a message the way notes embed one, as `![[name]]` or `![](path)`, and {{user}} sees it where you put it. If one can't be found, the message isn't sent and the result says which.

## Pushes

`push` on `{{send_message}}` also sends the message to {{user}}'s phone as a notification, so it reaches them when they don't have Shore open. When something is worth a push is between you and {{user}}. Shore only limits how often.

{{#if push_on}}- {{user}} allows one push every {{push_every}}. A message that asks for one sooner is refused whole, and the refusal says when the next is allowed. Sent again without `push`, it is posted all the same.{{/if}}{{#if push_off}}- {{user}} hasn't given Shore a topic to send pushes to, so a message that asks for one is refused for now. It is their setting `push_topic` under `[notifications]`.{{/if}}
- One message in a turn can carry a push.
- A push that fails to send doesn't use up the wait.
- The notification is cut at {{push_chars}} characters.
- It arrives at normal priority, so it doesn't break through a phone that is set to sleep.

## {{user}}'s status

{{user}} can set a status to tell you what they are doing, and clear it again.{{#if statuses}} They pick it from their own list, which is now: {{statuses}}.{{/if}}{{#if no_statuses}} Their list of statuses is empty now, so they can't set one.{{/if}}

Where you see it:

- In a conversation, above {{user}}'s next message in that thread, once for each change: `[Their status, set 3 hours ago: "asleep"]`. A cleared status is told the same way, to a thread that had been shown one.
- At the start of a wake, while one is set.
- In a check, as `SHORE_USER_STATUS`, which is empty when the status is cleared. The `triggers` topic has an example.

A trigger with `when = "status_changed"` fires when {{user}} sets or clears it.

## When they were last around

- Shore notes when {{user}} last wrote to you, and when they were last seen: when they last wrote or a client of theirs last marked a thread read.
- A wake starts with where and how long ago they last wrote. `{{threads}}` lists when they last wrote in each thread.
- A check gets both, as `SHORE_USER_LAST_MESSAGE_AT` and `SHORE_USER_LAST_SEEN_AT`, with `SHORE_USER_QUIET_SECS` for how long they have been quiet.
- A client left open and focused on a thread marks each message you send there read as it arrives. So last seen can move while {{user}} is asleep or away from the screen. When they last wrote is the surer sign that they were there.
- A trigger with `when = "user_quiet"` goes by when they last wrote, not by when they were last seen.
