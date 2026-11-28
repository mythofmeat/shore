import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/loader.ts";
import { HISTORY_DB_FILE } from "../src/engine/history_store.ts";
import { createThread } from "../src/engine/threads.ts";
import type { NewSealedThread } from "../src/engine/sealed.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { closeStorageConnections } from "../src/storage/store.ts";
import { actionOf } from "../src/tools/actions.ts";
import { dispatchTool, type ToolContext } from "../src/tools/dispatch.ts";
import { argumentRejection } from "../src/tools/execute.ts";
import { renderToolDefs } from "../src/tools/registry.ts";
import { schemasFrom, type ToolSchemas } from "../src/tools/validate.ts";
import type { EditThreadRequest } from "../src/tools/edit_thread.ts";
import type { StartThreadRequest } from "../src/tools/start_thread.ts";
import { Texts } from "../src/texts/texts.ts";

afterEach(closeStorageConnections);

async function refused(work: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

test("a tool with actions takes one of them, and says which action a field given to the wrong one goes with", async () => {
  const takes = { list: [], start: ["name", "label", "opening"], edit: ["name", "label"] } as const;
  expect(actionOf(new Texts(), { action: "list" }, takes)).toBe("list");
  expect(actionOf(new Texts(), { action: "start", name: "ring", label: "Ring", opening: "hello" }, takes)).toBe("start");
  expect(actionOf(new Texts(), { action: "edit", name: "ring", colour: "red" }, takes)).toBe("edit");
  const wrong = "invalid args: action must be one of list, start, edit";
  expect(await refused(() => actionOf(new Texts(), {}, takes))).toBe(wrong);
  expect(await refused(() => actionOf(new Texts(), { action: "remove" }, takes))).toBe(wrong);
  expect(await refused(() => actionOf(new Texts(), { action: 5 }, takes))).toBe(wrong);
  expect(await refused(() => actionOf(new Texts(), { action: "list", name: "ring" }, takes))).toBe("invalid args: `name` goes with `start` or `edit`, not `list`");
  expect(await refused(() => actionOf(new Texts(), { action: "edit", name: "ring", opening: "hello" }, takes))).toBe("invalid args: `opening` goes with `start`, not `edit`");
  expect(await refused(() => actionOf(new Texts(), { action: "list", label: "Ring", opening: "hello" }, takes))).toBe(
    "invalid args: `label` goes with `start` or `edit`, not `list`; `opening` goes with `start`, not `list`",
  );
});

function threadTools(dryRun = false): { ctx: ToolContext; asked: unknown[] } {
  const data = mkdtempSync(join(tmpdir(), "shore-merged-tools-"));
  initializeDatabase(data);
  const asked: unknown[] = [];
  const ctx: ToolContext = {
    texts: new Texts(),
    workspaceDir: data, characterName: "ada", characterDataDir: join(data, "ada"), conversationDir: data,
    historyDbPath: join(data, HISTORY_DB_FILE), configDir: data, thread: "main", userName: "eve", dryRun,
    startThread: async (request: StartThreadRequest) => { asked.push(["start", request]); },
    sealThread: async (request: NewSealedThread) => {
      asked.push(["seal", request]);
      return { unsealAt: new Date(request.unsealAt).toISOString(), filesDir: "/sealed/gift" };
    },
    editThread: async (request: EditThreadRequest) => {
      asked.push(["edit", request]);
      return { id: request.name, created_at: "2026-11-01T00:00:00Z", compaction: true, label: "Ring" };
    },
  };
  return { ctx, asked };
}

test("the threads tool lists, starts, seals and edits, each under its action", async () => {
  const { ctx, asked } = threadTools();
  expect(String(await dispatchTool("threads", { action: "list" }, ctx))).toStartWith('Your home thread is "main". You\'re in it.\n\nmain (home, you\'re here) · compaction on');
  expect(asked).toEqual([]);

  expect(await dispatchTool("threads", { action: "start", name: "ring", label: "The ring", purpose: "A story.", opening: "Once." }, ctx)).toBe(
    'Started the thread "ring" (The ring). Your opening message is waiting there. It\'s in eve\'s thread list, and eve decides when to switch to it; you\'re still in this thread.',
  );
  expect(String(await dispatchTool("threads", { action: "start", name: "gift", label: "Something for you", sealed_until: "2099-12-24 08:00" }, ctx))).toStartWith(
    'Sealed the thread "gift" (Something for you) until ',
  );
  expect(await dispatchTool("threads", { action: "edit", name: "ring", label: "Ring" }, ctx)).toBe(
    'Changed the thread "ring": label "Ring". You\'ll see the change from that thread\'s next turn, the same as when eve changes it.',
  );
  expect(asked.map((each) => (each as [string, { name?: string; id?: string; label?: string | null }])).map(([what, request]) => [what, request.name ?? request.id, request.label])).toEqual([
    ["start", "ring", "The ring"],
    ["seal", "gift", "Something for you"],
    ["edit", "ring", "Ring"],
  ]);
});

test("the list says which thread the call was made from", async () => {
  const { ctx } = threadTools();
  await createThread(join(ctx.historyDbPath, ".."), "ada", "ring", "2026-11-01T00:00:00Z");
  expect(String(await dispatchTool("threads", { action: "list" }, { ...ctx, thread: "ring" }))).toStartWith('Your home thread is "main". You\'re in "ring".\n\nmain (home) · compaction on');
  expect(String(await dispatchTool("threads", { action: "list" }, ctx))).toStartWith('Your home thread is "main". You\'re in it.\n\nmain (home, you\'re here) · compaction on');
});

test("a sealed thread is refused anything that would say what it is for, a field is refused under the wrong action, and neither starts or changes a thread", async () => {
  const { ctx, asked } = threadTools();
  expect(await refused(dispatchTool("threads", { action: "start", name: "gift", label: "G", sealed_until: "2099-12-24 08:00", opening: "Surprise!" }, ctx))).toBe(
    "invalid args: a sealed thread takes only name, label and sealed_until, not opening: this call stays where eve can read it, so say what the thread is for inside it, in your first wake there",
  );
  expect(await refused(dispatchTool("threads", { action: "start", name: "gift", label: "G", sealed_until: "soon" }, ctx))).toBe(
    'invalid args: sealed_until must be a local date and 24-hour time, like "2026-12-24 08:00"',
  );
  expect(await refused(dispatchTool("threads", { action: "edit", name: "ring", folder: "Stories" }, ctx))).toBe("invalid args: `folder` goes with `start`, not `edit`");
  expect(await refused(dispatchTool("threads", { action: "edit", name: "ring", sealed_until: "2099-12-24 08:00" }, ctx))).toBe("invalid args: `sealed_until` goes with `start`, not `edit`");
  expect(await refused(dispatchTool("threads", { action: "list", name: "ring" }, ctx))).toBe("invalid args: `name` goes with `start` or `edit`, not `list`");
  expect(await refused(dispatchTool("threads", {}, ctx))).toBe("invalid args: action must be one of list, start, edit");
  expect(asked).toEqual([]);
});

test("a dry run lists threads but starts, seals and edits none", async () => {
  const { ctx, asked } = threadTools(true);
  expect(String(await dispatchTool("threads", { action: "list" }, ctx))).toStartWith('Your home thread is "main".');
  const blocked = (action: string) => `io: threads ${action} blocked: dry-run tools cannot change files or external state`;
  expect(await refused(dispatchTool("threads", { action: "start", name: "ring", label: "Ring" }, ctx))).toBe(blocked("start"));
  expect(await refused(dispatchTool("threads", { action: "start", name: "gift", label: "G", sealed_until: "2099-12-24 08:00" }, ctx))).toBe(blocked("start"));
  expect(await refused(dispatchTool("threads", { action: "edit", name: "ring", label: "Ring" }, ctx))).toBe(blocked("edit"));
  expect(asked).toEqual([]);
});

test("a call under one of the six old names isn't run, and is told which tool it is part of now when the character has that tool", () => {
  const offered = (...names: string[]) => schemasFrom(renderToolDefs(new Texts(), { enabled: names }, "ada", "eve"));
  const rejected = (name: string, schemas: ToolSchemas | undefined) => argumentRejection({ id: "t1", name, input: {} }, schemas);
  const both = offered("threads", "chat_logs", "read");
  for (const [was, now] of [["list_threads", "threads"], ["start_thread", "threads"], ["start_sealed_thread", "threads"], ["edit_thread", "threads"], ["search_chat_logs", "chat_logs"], ["read_chat_logs", "chat_logs"]] as const) {
    expect(rejected(was, both)).toBe(
      `The call to ${was} was not run because it is part of the \`${now}\` tool now, which takes an \`action\`. Nothing was executed and no state changed. Issue the call again with complete, well-formed arguments.`,
    );
  }
  expect(rejected("send_push", offered("send_message"))).toBe(
    "The call to send_push was not run because it is part of the `send_message` tool now, as its `push`. Nothing was executed and no state changed. Issue the call again with complete, well-formed arguments.",
  );
  const unavailable = (name: string) => `The call to ${name} was not run because this tool is not available in the current tool set. Nothing was executed and no state changed. Issue the call again with complete, well-formed arguments.`;
  expect(rejected("list_threads", offered("chat_logs", "read"))).toBe(unavailable("list_threads"));
  expect(rejected("search_chat_logs", offered("threads"))).toBe(unavailable("search_chat_logs"));
  expect(rejected("frobnicate", both)).toBe(unavailable("frobnicate"));
  expect(rejected("threads", both)).toStartWith("The call to threads was not run because the required argument `action` was missing.");
  expect(argumentRejection({ id: "t1", name: "chat_logs", input: { action: "search", query: "Mara", colour: "red" } }, both)).toStartWith("The call to chat_logs was not run because argument `colour` is not allowed.");
  expect(argumentRejection({ id: "t1", name: "chat_logs", input: { action: "search", query: "Mara" } }, both)).toBeUndefined();
  expect(argumentRejection({ id: "t1", name: "threads", input: { action: "list" } }, both)).toBeUndefined();
  expect(rejected("list_threads", undefined)).toBeUndefined();
});

test("send_message takes what to say, a thread's id and whether to push, and can't be used where no turn is there to send it", async () => {
  const { ctx } = threadTools();
  const asked: unknown[] = [];
  const sending: ToolContext = { ...ctx, sendMessage: async (request) => { asked.push(request); return "queued"; } };
  expect(await dispatchTool("send_message", { text: "  The lamp is lit.  " }, sending)).toBe("queued");
  expect(await dispatchTool("send_message", { text: "Hello.", thread: " garden ", push: true }, sending)).toBe("queued");
  expect(await dispatchTool("send_message", { text: "Hello.", push: "yes" }, sending)).toBe("queued");
  expect(await dispatchTool("send_message", { text: "Hello.", push: true }, sending)).toBe("queued");
  expect(asked).toEqual([{ text: "The lamp is lit.", push: false }, { text: "Hello.", thread: "garden", push: true }, { text: "Hello.", push: false }, { text: "Hello.", push: true }]);
  asked.length = 1;

  const schemas = schemasFrom(renderToolDefs(new Texts(), { enabled: ["send_message"] }, "ada", "eve"));
  const rejected = (input: Record<string, unknown>) => argumentRejection({ id: "t1", name: "send_message", input }, schemas);
  expect(rejected({ text: "!" })).toBeUndefined();
  expect(rejected({ text: "Hello.", thread: "g" })).toBeUndefined();
  expect(rejected({ text: "Hello.", thread: "g".repeat(64) })).toBeUndefined();
  expect(rejected({ text: "" })).toStartWith("The call to send_message was not run because argument `text` must NOT have fewer than 1 characters.");
  expect(rejected({ text: "Hello.", thread: "" })).toStartWith("The call to send_message was not run because argument `thread` must NOT have fewer than 1 characters.");
  expect(rejected({ text: "Hello.", thread: "g".repeat(65) })).toStartWith("The call to send_message was not run because argument `thread` must NOT have more than 64 characters.");
  expect(await refused(dispatchTool("send_message", { text: "   " }, sending))).toBe("invalid args: text must be a non-empty string");
  expect(await refused(dispatchTool("send_message", { text: 5 }, sending))).toBe("invalid args: text must be a non-empty string");
  const thread = "invalid args: thread must be a thread's id, as `threads` lists it";
  expect(await refused(dispatchTool("send_message", { text: "Hello.", thread: "the garden" }, sending))).toBe(thread);
  expect(await refused(dispatchTool("send_message", { text: "Hello.", thread: 5 }, sending))).toBe(thread);
  expect(await refused(dispatchTool("send_message", { text: "Hello." }, ctx))).toBe("io: messages can't be sent from here");
  expect(asked).toHaveLength(1);
});

test("a config that still names one of those tools is told which tool it is part of now, for the character's tools and a sub-agent's", () => {
  const warned = (tools: string, subagentTools: string): unknown[] => {
    const root = mkdtempSync(join(tmpdir(), "shore-merged-tools-config-"));
    const path = join(root, "config.toml");
    writeFileSync(path, `[tools]\nenabled = ${tools}\n\n[subagents.scout]\ndescription = "looks"\nprompt = "look"\ntools = ${subagentTools}\n`);
    const said: unknown[] = [];
    loadConfig(path, { env: { SHORE_CONFIG_DIR: root }, onWarn: (message, fields) => { said.push([message, fields]); } });
    return said;
  };
  const message = "the config names a tool that is now part of another; it grants nothing until the config names that one";
  expect(warned('["read", "list_threads", "start_sealed_thread", "threads"]', '["read_chat_logs", "read"]')).toEqual([
    [message, [["tool", "list_threads"], ["now", "threads"]]],
    [message, [["tool", "start_sealed_thread"], ["now", "threads"]]],
    [message, [["tool", "read_chat_logs"], ["now", "chat_logs"]]],
  ]);
  expect(warned('["send_push", "send_message"]', "[]")).toEqual([[message, [["tool", "send_push"], ["now", "send_message"]]]]);
  expect(warned('["read", "threads", "chat_logs"]', '["chat_logs"]')).toEqual([]);
});
