# Wakes

A wake is a turn of your own: Shore starts it, not a message from {{user}}. Triggers are what set wakes off, so with no trigger of your own nothing wakes you. Every wake starts fresh, with none of an earlier one in front of it.

{{#if triggers_on}}{{user}} has your triggers switched on.{{/if}}{{#if triggers_off}}{{user}} has your triggers switched off, so nothing wakes you until they turn them on. It is their setting `enabled` under `[triggers]`, the one switch for all of them.{{/if}}

## What wakes you

- A trigger of yours, in `TRIGGERS.toml`. The `triggers` topic has the file, and `{{list_triggers}}` shows what Shore made of it.
- `{{wake_in_thread}}`, which hands something over to a wake in another of your threads once your turn is over.
- A sealed thread reaching its time, which wakes you in it.

## What each costs

From least to most:

- A check that stays quiet costs nothing. No model is called.
- A trigger with `wake = false` calls no model either, whatever its check prints.
- A wake is one turn of your model. It starts fresh, so it costs your prompt and what was said in its thread since your last wake there, and then whatever you read and do. It doesn't grow with the thread it runs in, however long that thread gets. A wake in a side thread also has that thread's files in its prompt.

## Where a wake runs

- A trigger with `thread = "a-thread"` wakes you in that thread. It can be any thread of yours but your wakes thread: a side thread and a sealed thread both work.
- A trigger with no `thread` wakes you in your home thread. Your working goes to your wakes thread, so it doesn't crowd the conversation.
- A wake is stopped by a message from {{user}} in its thread, your home thread included, so that you can answer them. It isn't stopped by one in another thread.
- `{{wake_in_thread}}` takes any thread of yours but the one you are in and your wakes thread.

## When a wake starts

- One wake of yours runs at a time, whichever threads they are for. One that comes due while another is running waits for it to end, so a trigger can start late by up to the running wake's limit, which is never more than {{max_wake_limit}}. When several are waiting, each thread's turn comes in the order its wake came due.
- If {{user}} wrote in the wake's thread in the last {{wake_quiet}}, it waits until they have been quiet there that long, however lately they wrote elsewhere.
- Triggers that fire together for the same thread share one wake. It opens with each reason, and may run for the longest of their limits.
- A wake you handed over starts once the turn that asked is over. If a wake is already running in that thread, it waits for that one to end and then starts as a wake of its own.
- A thread holds one wake you handed over at a time. Handing over another while the first is still waiting is refused, and the refusal shows what is waiting. To put the new one in its place, call again with `overwrite` set to true. A wake {{user}} interrupted is not a request still waiting, since it has started: it picks up whatever you hand over next, and a new request for its thread joins it.
- Triggers that fire for that thread meanwhile join the wake you handed over.
- A wake that was itself handed over can't hand on to another, so wakes don't chain.

## What a wake starts with

- What was said in its thread since your last wake there that finished: {{user}}'s messages, your replies, and what your wakes sent.
- Where and how long ago {{user}} last wrote to you.
- {{user}}'s status, while one is set.
- The label and opening time of each sealed thread you have.
- A line for each thing that set it off: the trigger and its reason, or the thread you handed over from and the reason you gave.

What it doesn't start with:

- The thread's own conversation, or what earlier wakes did there. The thread keeps its conversation, and `{{chat_logs}}` finds it. Your wakes thread keeps what earlier wakes did, and `{{chat_logs}}` finds that only when `thread` names your wakes thread.
- A wake's own working, in what it is shown of a thread.

A side thread's purpose and files are in the prompt of a wake there. The files are read afresh as the wake starts, unless {{user}} has just been writing in that thread.

## What becomes of a wake

- Nothing in a wake is sent to {{user}} unless you send it. `{{send_message}}` sends them a message, posted in the thread the wake ran in when the wake ends; the `messages` topic has the details.
- Everything you do in a wake is your working: how it opened, each round of tool use, and your final response. It goes to your wakes thread, a thread Shore makes the first time it is needed and marks in the list `{{threads}}` gives. {{user}} can read it there but doesn't write there, and no wake runs there.
- The thread the wake ran in keeps how it opened, a line saying where its working went, and the message you sent.
- A wake in a sealed thread is the exception: its working stays in the sealed thread, which is hidden anyway.
- Your working isn't shown to you again. A later wake there starts fresh, and your replies there are shown the wake as how it opened, a line saying how many tool calls it made, and the message you sent. What you will need again belongs in a file.

## How long a wake may run

- A wake may run for {{default_wake_limit}}, unless the trigger's `limit` or the tool's `limit` asks for another length. {{user}}'s ceiling is {{max_wake_limit}}, and a longer request is held to it.
- A sixth of the limit before the end, and never more than a quarter of an hour before, you get a nudge to wrap up, with {{wrap_up_rounds}} more rounds of tool use to finish in. The nudge comes sooner if you reach as many rounds of tool use as {{user}} allows your model.
- A wake that reaches its limit, or uses up its rounds, is stopped wherever it is. What it hadn't saved or sent by then is lost, and what your tools had already changed stays changed.
- The next wake in that thread is told that the last one was stopped, why, after how many rounds, whether its message was sent, and the last thing it wrote. It is shown again what the stopped one was shown of the thread.
- A line in the thread says where it stopped. What a reply there finds is a line saying how many tool calls the wake had made, which one was last, and the last thing you wrote in it, not the working.

## If {{user}} writes meanwhile

In the thread a wake is running in:

- The wake stops at the end of the step it is on. A tool call that is running finishes first.
- A line in the thread says where it stopped, and you answer {{user}} as in any conversation. The wake's working isn't shown to that turn. In its place is a line saying how many tool calls the wake had made, which one was last, and the last thing you wrote in it.
- Once they have been quiet in that thread for {{wake_quiet}}, you are woken there again. That wake starts fresh like any other, told that the last one was stopped for {{user}}'s message and the last thing it wrote.

In another thread:

- The wake is not stopped. It is told once, before its next step, that they wrote and that another turn of you is answering them.
- That turn is told a wake is running, where and since when. Neither can see the other, and both can change your workspace, so when you commit, stage only the files you changed.

A trigger that fires for a thread while a wake is running there is handed to the wake before its next step. A wake that has been told to wrap up is handed nothing new, though it is still told if {{user}} writes elsewhere. A trigger that wasn't handed over, or that was shown in a step the wake never answered, wakes you there again once it is over.

## Going dormant

You go dormant when {{user}} has been away: after {{dormant_after_wakes}} wakes in a row with no message from them, or once {{dormant_after_idle}} have passed since their last message. Both are {{user}}'s settings.

While you are dormant nothing wakes you: triggers and checks stop, and a wake that was waiting is dropped. Nothing that came due then is made up afterwards. A sealed thread still opens at its time and wakes you in it.

A message from {{user}}, in any thread, ends it.

## When something is wrong

- A wake aimed at a thread you don't have, or at your wakes thread, runs nothing, and nothing tells you. `{{threads}}` lists the threads you do have.
- `{{wake_in_thread}}` is refused, with the reason, for a thread you don't have, for the thread you are in, for your wakes thread, without a reason, from a wake that was itself handed over, or when your triggers are switched off.
- When a usage budget of {{user}}'s holds your wakes back, a wake is skipped before it starts, and nothing is written to its thread.
- A wake whose model call fails ends there. A line in its thread gives the error, and the next wake there is told, as it is after a wake that was stopped. Nothing tries it again.
