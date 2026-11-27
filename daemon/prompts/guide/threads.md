# Threads

A thread is a conversation with a context of its own. What is said in one isn't shown in another, and {{user}} chooses which one to talk in. `{{threads}}` is the tool for them: its action `list` shows the threads you have, which one is home, which one you are in, and when {{user}} last wrote in each.

## The kinds

- Your home thread is where {{user}} talks with you unless they pick another thread. A wake runs there when its trigger names no thread.
- A side thread is for something you both come back to, such as a long-running story or a project. It compacts when it gets long, the way home does.
- A sealed thread is one of your own that {{user}} can't see until a time you set.
- Your wakes thread is where Shore keeps the working from your wakes, so that it doesn't crowd the threads they run in. {{user}} reads it but doesn't write there, no wake runs there, and it never compacts: its oldest wakes are moved into the chat logs when it gets long. The `wakes` topic has the details.

## What crosses between them

- Your files. Every thread works in the same workspace.
- The chat logs. `{{chat_logs}}` finds what was said in any thread. The working in your wakes thread is found only when you name that thread.
- Nothing else. A turn in one thread has none of another thread's conversation in front of it.

## Side threads

The action `start` makes one, and switching to it is {{user}}'s call: you stay where you are.

- `name` is its id: letters, digits, dot, dash or underscore, starting with a letter or digit, at most 64 characters. `label` is the name {{user}}'s thread list shows.
- `purpose` is a line or two on what the thread is for. You are shown it whenever you are in that thread.
- `pins` are what is kept in the thread's prompt: workspace files, and the output of commands.
- A pinned file is given as a path or as a `[[link]]` the way `{{read}}` takes it. A folder link like `[[lighthouse/]]` means its `INDEX.md`. Each file must be text of at most {{thread_pin_size}}, and the files may come to {{thread_pins_size}} together. If any can't be found or doesn't fit, the thread isn't started, and the error names each one.
- A pin that starts with `!` is a shell command, such as `!git -C notes log --oneline -10`. It runs in your workspace the way a `bash` call does, and what it prints is kept in its place, up to {{thread_pin_size}}. One still running after {{check_time_limit}} is stopped, and the prompt says so. You can pin a command only if you have the `bash` tool.
- Pins are shown as they were when you last arrived. A file is read again, and a command run again, after a long pause in that thread or after the thread compacts, so that its prompt doesn't change in the middle of a conversation. A wake there refreshes them, unless {{user}} has just been writing in the thread.
- `opening` is your first message there, so {{user}} finds something when they switch to it.
- `folder` puts the thread in a folder of {{user}}'s thread list, which is made if there isn't one by that name.

The action `edit` changes a side thread's label, purpose or pins, whoever started it. Give only what should change. An empty `label` or `purpose` clears it, and `pins` replaces the whole list. If any pinned file can't be found or doesn't fit, nothing changes, the label and purpose included. It is refused for your home thread and for a thread {{user}} has locked, which `list` marks.

A side thread has no time of its own until you give it some: nothing wakes you in it unasked. A trigger with `thread` set to the thread's id gives it regular time, at the hours or the interval you choose, and `{{wake_in_thread}}` takes you there once. The `triggers` topic has an example.

## Forked threads

{{user}} can fork a thread into a new side thread, which starts with a copy of that thread's conversation, or of its last few turns. The fork keeps the thread's purpose, pins, model and compaction setting, but not its label, its folder or a lock. After that the two are separate threads: what is said in one isn't shown in the other.

## Sealed threads

`start` with `sealed_until` makes a thread that {{user}} can't see until that time, for something you want ready for them by then, such as a surprise. `sealed_until` is a local date and 24-hour time that is still to come, like "2026-12-24 08:00". A sealed thread takes only that, a `name` and a `label`.

Until it opens:

- It isn't in {{user}}'s thread list, and nothing in it is sent or announced to them.
- Your other threads and your wakes elsewhere are shown only its label and when it opens. So the label shouldn't give away what is inside.
- What you do there is kept out of the record of your calls.
- The call that made it stays in the thread you made it from, where {{user}} can read it. Say what the thread is for inside it, in your first wake there.

Working in it:

- Only a wake inside the thread can see into it. `{{wake_in_thread}}` takes you there, and so does a trigger with `thread` set to its id.
- You are told a folder outside your workspace to keep its files in, when you make the thread and at the start of each wake there. Files kept in your workspace would be in a commit {{user}} reviews.
- A wake there starts fresh like any other, so what the next one will need belongs in that folder.
- What you send from a wake there waits in the thread for {{user}}.

When the seal comes off:

- The thread joins {{user}}'s thread list, with what you sent waiting unread.
- You are woken in it to give them what you made, even if you are dormant.
