import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keptDiary } from "../src/autonomy/diary.ts";
import { Outbox, postElsewhere, reachableThreads, sendingsHere, type OutboxSetup } from "../src/autonomy/outbox.ts";
import type { PushRefusal } from "../src/autonomy/push.ts";
import { createThread } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { closeStorageConnections } from "../src/storage/store.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";

afterEach(closeStorageConnections);

const T0 = Date.UTC(2026, 9, 30, 12);

function outbox(over: Partial<OutboxSetup> = {}): Outbox {
  return new Outbox({
    turn: "wake",
    here: "main",
    sealed: false,
    userName: "eve",
    timeZone: "UTC",
    threads: async () => ({ open: ["main", "garden", "wakes"], wakes: "wakes", sealed: ["gift"] }),
    pictureProblems: async () => [],
    pushRefusal: () => undefined,
    ...over,
  });
}

async function refused(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

test("a wake's message waits for the end of the wake, in its own thread unless it names another", async () => {
  const box = outbox();
  expect(await box.send({ text: "The lamp is lit.", push: false })).toBe("It will be posted in this thread when this wake ends.");
  expect(await box.send({ text: "Same place.", thread: "main", push: false })).toBe("It will be posted in this thread when this wake ends.");
  expect(await box.send({ text: "The beans are up.", thread: "garden", push: true })).toBe('It will be posted in "garden" when this wake ends. It goes to eve\'s phone then too.');
  expect(box.waiting).toEqual([
    { text: "The lamp is lit.", thread: "main", push: false },
    { text: "Same place.", thread: "main", push: false },
    { text: "The beans are up.", thread: "garden", push: true },
  ]);
});

test("a reply's message has to name another thread, since the reply is the message in its own", async () => {
  const box = outbox({ turn: "reply" });
  const here = "io: your reply here is already a message to eve; `send_message` is for saying something in another thread, so name one with `thread`";
  expect(await refused(box.send({ text: "Hello.", push: false }))).toBe(here);
  expect(await refused(box.send({ text: "Hello.", thread: "main", push: false }))).toBe(here);
  expect(await box.send({ text: "Hello.", thread: "garden", push: false })).toBe('It will be posted in "garden" when this turn ends.');
  expect(box.waiting).toEqual([{ text: "Hello.", thread: "garden", push: false }]);
});

test("a message is refused for a thread that isn't there, for the wakes thread and for a sealed thread, and nothing waits", async () => {
  const box = outbox();
  expect(await refused(box.send({ text: "Hello.", thread: "nowhere", push: false }))).toBe('io: you have no thread "nowhere" to send it in; `threads` lists the ones you have');
  expect(await refused(box.send({ text: "Hello.", thread: "wakes", push: false }))).toBe('io: "wakes" is where Shore keeps the working from your wakes, and nothing is sent there');
  expect(await refused(box.send({ text: "Hello.", thread: "gift", push: false }))).toBe('io: "gift" is sealed, so only a wake inside it can leave a message there');
  expect(box.waiting).toEqual([]);
});

test("a wake in a sealed thread sends only inside it, and never with a push", async () => {
  const box = outbox({ here: "gift", sealed: true });
  expect(await refused(box.send({ text: "Hello.", thread: "main", push: false }))).toBe(
    "io: a wake in a sealed thread sends nothing outside it: leave `thread` out, and the message waits here until the thread opens",
  );
  expect(await refused(box.send({ text: "Hello.", push: true }))).toBe(
    "io: not sent: nothing from a sealed thread is announced before it opens, a push included. Send it again without `push` to post it all the same.",
  );
  expect(await box.send({ text: "Happy birthday!", push: false })).toBe("It will be posted in this thread when this wake ends.");
  expect(box.waiting).toEqual([{ text: "Happy birthday!", thread: "gift", push: false }]);
});

test("a message with a picture that can't be found is refused with each one named, and nothing waits", async () => {
  const box = outbox({ pictureProblems: async (text) => text.includes("![[") ? ["![[lamp.png]]: no file by that name", "![[tide.png]]: too large"] : [] });
  expect(await refused(box.send({ text: "Look: ![[lamp.png]] ![[tide.png]]", push: false }))).toBe(
    "io: not sent: these pictures in it could not be sent:\n- ![[lamp.png]]: no file by that name\n- ![[tide.png]]: too large\nSend it again with the names fixed.",
  );
  expect(box.waiting).toEqual([]);
  expect(await box.send({ text: "No pictures.", push: false })).toBe("It will be posted in this thread when this wake ends.");
});

test("a push is refused whole when none is set up, when one went too lately, or when the turn already has one", async () => {
  const without = "Send it again without `push` to post it all the same.";
  let refusal: PushRefusal | undefined = { kind: "not_set_up" };
  const box = outbox({ pushRefusal: () => refusal });
  expect(await refused(box.send({ text: "Hello.", push: true }))).toBe(`io: not sent: push notifications aren't set up, because eve hasn't given Shore a topic to send them to. ${without}`);
  refusal = { kind: "too_soon", lastAt: T0, nextAt: T0 + 86_400_000 };
  expect(await refused(box.send({ text: "Hello.", push: true }))).toBe(
    `io: not sent: your last push was Friday 2026-10-30 · 12:00 PM, and the next one is allowed from Saturday 2026-10-31 · 12:00 PM. ${without}`,
  );
  expect(box.waiting).toEqual([]);
  expect(await box.send({ text: "Hello.", push: false })).toBe("It will be posted in this thread when this wake ends.");

  refusal = undefined;
  expect(await box.send({ text: "Now with a push.", push: true })).toBe("It will be posted in this thread when this wake ends. It goes to eve's phone then too.");
  expect(await refused(box.send({ text: "And another.", push: true }))).toBe(
    `io: not sent: a message with a push is already waiting to go when this turn ends, and that push is the one allowed for now. ${without}`,
  );
  expect(box.waiting.map((each) => [each.text, each.push])).toEqual([["Hello.", false], ["Now with a push.", true]]);
});

test("pictures a turn made go with its first message here, or alone when it sent none, and a turn with neither posts nothing", () => {
  const lamp = { path: "/sent/lamp.png" };
  const one = { text: "One.", thread: "main", push: true };
  const two = { text: "Two.", thread: "main", push: false };
  expect(sendingsHere([], [])).toEqual([]);
  expect(sendingsHere([], [lamp])).toEqual([{ text: "", images: [lamp], push: false }]);
  expect(sendingsHere([one], [])).toEqual([{ text: "One.", images: [], push: true }]);
  expect(sendingsHere([one, two], [lamp])).toEqual([{ text: "One.", images: [lamp], push: true }, { text: "Two.", images: [], push: false }]);
});

function scratch(): { data: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "shore-outbox-"));
  const data = join(root, "data");
  initializeDatabase(data);
  return { data, workspace: root };
}

test("the threads a message can go to are the character's own, with its wakes thread and its sealed ones told apart", async () => {
  const { data } = scratch();
  expect(await reachableThreads(data, "ada")).toEqual({ open: ["main"], wakes: undefined, sealed: [] });
  await createThread(data, "ada", "garden", "2026-11-01T00:00:00Z");
  expect(await reachableThreads(data, "ada")).toEqual({ open: ["main", "garden"], wakes: undefined, sealed: [] });
});

test("messages for other threads are posted in the order they were sent, and one whose thread has gone is said so in the diary", async () => {
  const { data, workspace } = scratch();
  const posted: [thread: string, content: string][] = [];
  const engine = (thread: string) => ({ appendMessage: async (message: Message) => { posted.push([thread, message.content]); }, currentRevision: () => 1 });
  await postElsewhere(
    [{ text: "One.", thread: "garden", push: false }, { text: "Lost.", thread: "attic", push: false }, { text: "Two.", thread: "garden", push: false }],
    { character: "ada", from: "main", turn: "wake", characterDir: join(data, "ada"), engine: async (thread) => thread === "attic" ? undefined : engine(thread), now: () => T0 },
    { provider_key: "anthropic", model: "claude-lamp" },
    {},
    () => {},
    { workspace: new CharacterWorkspace(workspace), dir: join(workspace, "sent") },
  );
  expect(posted).toEqual([["garden", "One."], ["garden", "Two."]]);
  expect(keptDiary(join(data, "ada"), Date.now()).map((note) => [note.source, note.thread, note.at, note.text])).toEqual([
    ["shore", "", new Date(T0).toISOString(), 'Your message for the thread "attic" was not sent: that thread was gone by the time your wake in "main" ended.'],
  ]);
});
