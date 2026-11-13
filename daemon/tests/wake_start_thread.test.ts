import { afterAll, expect, test } from "bun:test";
import { readThreadsIndex } from "../src/engine/threads.ts";
import { handleListThreads } from "../src/tools/list_threads.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { eventsForResponse } from "./support/stream.ts";
import { afterFirstChat } from "./support/chat_world.ts";
import { restoreTestEnv } from "./support/env.ts";

const KEY_ENV = "SHORE_WAKE_START_THREAD_KEY";

afterAll(restoreTestEnv);

const START_AND_EDIT: GenerateResponse["content_blocks"] = [
  {
    type: "tool_use",
    id: "start",
    name: "start_thread",
    input: { name: "lighthouse", label: "The lighthouse story", opening: "The lamp was already lit when we got there." },
  },
  { type: "tool_use", id: "edit", name: "edit_thread", input: { name: "lighthouse", purpose: "The keeper's winter, a chapter at a time." } },
];

function threadToolsProvider(toolResults: string[], calls: GenerateResponse["content_blocks"] = START_AND_EDIT): SidecarProvider {
  const reply = (request: SidecarRequest): GenerateResponse => {
    const waking = request.context?.call_type.startsWith("heartbeat") === true;
    const tail = request.messages.at(-1)?.content;
    const results = Array.isArray(tail) ? tail.filter((block) => block.type === "tool_result") : [];
    for (const result of results) toolResults.push(JSON.stringify(result));
    const call = waking ? calls[toolResults.length] : undefined;
    const blocks: GenerateResponse["content_blocks"] = call === undefined
      ? [{ type: "text", text: waking ? "NO_NOTE" : "hello" }]
      : [call];
    return {
      model: request.model,
      content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
      content_blocks: blocks,
      finish_reason: call === undefined ? "end_turn" : "tool_use",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    };
  };
  return { generate: async (request) => reply(request), stream: (request) => eventsForResponse(reply(request)) };
}

test("a thread started and edited on a wake opens with her message, takes the edit and shows up for the user, as in chat", async () => {
  const toolResults: string[] = [];
  const events: ServerMessage[] = [];
  await afterFirstChat({
    name: "wake-start-thread",
    keyEnv: KEY_ENV,
    provider: threadToolsProvider(toolResults),
    tools: ["start_thread", "edit_thread"],
    autonomy: true,
    model: { maxToolIterations: 3 },
    emitEvent: (event) => events.push(event),
  }, async ({ config, runtime }) => {
    expect(runtime.autonomy.wakeNow("ada")).toBeDefined();
    await runtime.autonomy.tick();

    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toContain('Started the thread \\"lighthouse\\"');
    expect(toolResults[1]).toContain('Changed the thread \\"lighthouse\\": purpose set.');
    const threads = await readThreadsIndex(config.dirs.data, "ada");
    expect(threads?.threads.find((thread) => thread.id === "lighthouse")).toMatchObject({
      label: "The lighthouse story", purpose: "The keeper's winter, a chapter at a time.", created_by: "character",
    });
    const thread = await runtime.registry.getOrCreate("ada", "lighthouse");
    expect(thread.messages().map((message) => [message.role, message.content])).toEqual([
      ["assistant", "The lamp was already lit when we got there."],
    ]);
    expect(events.filter((event) => event.type === "new_message" && event.thread === "lighthouse")).toHaveLength(1);
    expect(events.filter((event) => event.type === "threads_changed")).toEqual([
      { type: "threads_changed", character: "ada", thread: "lighthouse" },
      { type: "threads_changed", character: "ada", thread: "lighthouse" },
    ]);
  });
});

test("a thread started with a folder goes in that folder of the user's thread list, which is made if it isn't there, and a folder name that can't be used starts nothing", async () => {
  const toolResults: string[] = [];
  const start = (id: string, name: string, folder: string): GenerateResponse["content_blocks"][number] => ({
    type: "tool_use", id, name: "start_thread", input: { name, label: name, folder },
  });
  await afterFirstChat({
    name: "start-thread-folder",
    keyEnv: KEY_ENV,
    provider: threadToolsProvider(toolResults, [
      start("a", "lighthouse", " Projects "),
      start("b", "harbor", "projects"),
      start("c", "quay", "p".repeat(65)),
      start("d", "pier", "Stories"),
    ]),
    tools: ["start_thread"],
    autonomy: true,
    model: { maxToolIterations: 5 },
  }, async ({ config, runtime }) => {
    expect(runtime.autonomy.wakeNow("ada")).toBeDefined();
    await runtime.autonomy.tick();

    expect(toolResults.map((result) => (JSON.parse(result) as { content: string }).content)).toEqual([
      'Started the thread "lighthouse" (lighthouse). It\'s in the "Projects" folder of peggy\'s thread list, and peggy decides when to switch to it; you\'re still in this thread.',
      'Started the thread "harbor" (harbor). It\'s in the "projects" folder of peggy\'s thread list, and peggy decides when to switch to it; you\'re still in this thread.',
      "io: a folder name can be at most 64 characters",
      'Started the thread "pier" (pier). It\'s in the "Stories" folder of peggy\'s thread list, and peggy decides when to switch to it; you\'re still in this thread.',
    ]);
    const index = await readThreadsIndex(config.dirs.data, "ada");
    expect(index?.folders).toEqual([{ name: "Projects", threads: ["lighthouse", "harbor"] }, { name: "Stories", threads: ["pier"] }]);
    expect(index?.threads.map((thread) => thread.id)).toEqual(["main", "lighthouse", "harbor", "pier"]);
    const listed = await handleListThreads({ dataDir: config.dirs.data, character: "ada", userName: "peggy", timeZone: "UTC" });
    expect(listed).toContain('harbor "harbor" (in the folder "Projects") · compaction on');
    expect(listed).toContain('pier "pier" (in the folder "Stories") · compaction on');
    expect(listed).toContain("main (home, you're here) · compaction on");
  });
});
