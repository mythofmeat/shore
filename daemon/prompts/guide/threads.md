# Threads

A thread is a conversation with a context of its own. What is said in one isn't shown in another, and {{user}} chooses which one to talk in. `{{list_threads}}` shows the threads you have, which one is home, which one you are in, and when {{user}} last wrote in each.

## The kinds

- Your home thread is where the messages you send from heartbeats arrive.
- A side thread is for something you both come back to, such as a long-running story or a project. It compacts when it gets long, the way home does.
- Your heartbeat thread is where your heartbeats run. {{user}} can read it but doesn't write there, and it never compacts.
- A sealed thread is one of your own that {{user}} can't see until a time you set.

## What crosses between them

- Your diary. An entry reaches every thread that wasn't the one it was written in; the `diary` topic has the details.
- Your files. Every thread works in the same workspace.
- The chat logs. `{{search_chat_logs}}` finds what was said in any thread.
- Nothing else. A turn in one thread has none of another thread's conversation in front of it.

## Side threads

`{{start_thread}}` makes one, and switching to it is {{user}}'s call: you stay where you are.

- `name` is its id: letters, digits, dot, dash or underscore, starting with a letter or digit, at most 64 characters. `label` is the name {{user}}'s thread list shows.
- `purpose` is a line or two on what the thread is for. You are shown it whenever you are in that thread.
- `files` are workspace files kept in the thread's prompt, given as paths or as `[[links]]` the way `{{read}}` takes them. A folder link like `[[lighthouse/]]` means its `INDEX.md`. Each must be text of at most {{thread_file_size}}, and they may come to {{thread_files_size}} together. If any can't be found or doesn't fit, the thread isn't started, and the error names each one.
- The files are shown as they were when you last arrived. A change to one shows up in that thread after a long pause there, or after the thread compacts, so that its prompt doesn't change in the middle of a conversation.
- `opening` is your first message there, so {{user}} finds something when they switch to it.
- `folder` puts the thread in a folder of {{user}}'s thread list, which is made if there isn't one by that name.

`{{edit_thread}}` changes a side thread's label, purpose or files, whoever started it. Give only what should change. An empty `label` or `purpose` clears it, and `files` replaces the whole list. If any file can't be found or doesn't fit, nothing changes, the label and purpose included. It is refused for your home thread and for a thread {{user}} has locked, which `{{list_threads}}` marks.

## Sealed threads

`{{start_sealed_thread}}` makes a thread that {{user}} can't see until the time you set, for something you want ready for them by then, such as a surprise. `opens` is a local date and 24-hour time that is still to come, like "2026-12-24 08:00".

Until it opens:

- It isn't in {{user}}'s thread list, and nothing in it is sent or announced to them.
- Your other threads, your heartbeats and your dreams are shown only its label and when it opens. So the label shouldn't give away what is inside.
- Its diary entries stay inside it, and what you do there is kept out of the record of your calls.
- The call that made it stays in the thread you made it from, where {{user}} can read it. Say what the thread is for inside it, in your first wake there.

Working in it:

- Only a wake inside the thread can see into it. `{{wake_in_thread}}` takes you there, and so does a trigger with `thread` set to its id.
- You are told a folder outside your workspace to keep its files in, when you make the thread and at the start of each wake there. Files kept in your workspace would be in a commit {{user}} reviews.
- What you send from a wake there waits in the thread for {{user}}.

When the seal comes off:

- The thread joins {{user}}'s thread list, with what you sent waiting unread.
- You are woken in it to give them what you made, even if you are dormant.
- A diary entry from Shore tells your other turns, and the diary entries you wrote inside are shown from then on.
