import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CharacterRegistry } from "../src/characters.ts";

import { ConversationEngine } from "../src/engine/conversation.ts";
import { shoreLog } from "../src/log.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { INTERRUPTED_REPLY_NOTE } from "../src/engine/interrupted_note.ts";
import { markReplyRunning } from "../src/engine/interrupted_reply.ts";
import type { Message } from "../src/engine/types.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { durableExists, threadFile, writeDurable } from "../src/storage/files.ts";
import { reliabilityGeneration } from "./support/reliability_generation.ts";
import { testTmp } from "./support/tmp.ts";
import { promptedAppConfig } from "./support/prompt_list.ts";

const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
const timing = { total_ms: 1, time_to_first_token_ms: 1 };
const running = (data: string, thread = "main") => durableExists(threadFile(data, "ada", thread, "reply_running.json"));

async function registryFor(data: string): Promise<CharacterRegistry> {
  const root = join(data, "..");
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "characters", "ada", "workspace"), { recursive: true });
  writeFileSync(join(configDir, "characters", "ada", "workspace", "SOUL.md"), "Ada");
  const loaded: LoadedConfig = {
    app: promptedAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(),
    dirs: { config: configDir, data, runtime: join(root, "runtime"), cache: join(root, "cache") }, rawTable: undefined,
  };
  return await CharacterRegistry.create(configDir, data, loaded);
}

describe("a reply Shore was making when it stopped", () => {
  test("is marked in its thread while it runs, and the mark goes however the reply ends", async () => {
    const seen: boolean[] = [];
    let fail = false;
    const h = await reliabilityGeneration({
      generate: async () => { throw new Error("stream only"); },
      async *stream(): AsyncIterable<StreamEvent> {
        seen.push(running(h.config.dirs.data));
        if (fail) throw new Error("the model went away");
        yield { type: "done", content: "Hello.", finish_reason: "end_turn", usage, timing };
      },
    });
    await h.run();
    expect([seen, running(h.config.dirs.data)]).toEqual([[true], false]);
    fail = true;
    expect(await h.run().then(() => "finished", () => "failed")).toBe("failed");
    expect([seen.length > 1, seen.every(Boolean), running(h.config.dirs.data)]).toEqual([true, true, false]);
  });

  test("gets a note in its thread when the thread next loads, once, which the user can see and the model reads", async () => {
    const data = join(mkdtempSync(testTmp("shore-interrupted-")), "data");
    mkdirSync(data, { recursive: true });
    writeDurable(threadFile(data, "ada", "main", "reply_running.json"), JSON.stringify({ instance: "an earlier daemon" }));
    const engine = await (await registryFor(data)).getOrCreate("ada");
    expect(engine.messages().map((message) => [message.role, message.content])).toEqual([["system", INTERRUPTED_REPLY_NOTE]]);
    expect(running(data)).toBe(false);
    const again = await (await registryFor(data)).getOrCreate("ada");
    expect(again.messages().map((message) => message.content)).toEqual([INTERRUPTED_REPLY_NOTE]);
  });

  test("that stopped inside a tool call gets an error result for the call, then the note, and the daemon says how many calls it recovered", async () => {
    const data = join(mkdtempSync(testTmp("shore-interrupted-")), "data");
    mkdirSync(data, { recursive: true });
    const before = await ConversationEngine.load("ada", data, undefined, "main");
    const at = new Date().toISOString();
    await before.appendMessage({ msg_id: "m_asked", role: "user", content: "Look it up.", images: [], content_blocks: [{ type: "text", text: "Look it up." }], timestamp: at });
    await before.appendMessage({ msg_id: "m_used", role: "assistant", content: "", images: [], content_blocks: [{ type: "tool_use", id: "call", name: "read", input: { path: "notes.md" } }], timestamp: at });
    writeDurable(threadFile(data, "ada", "main", "reply_running.json"), JSON.stringify({ instance: "an earlier daemon" }));
    const warned = spyOn(shoreLog, "warn").mockImplementation(() => {});
    try {
      const engine = await (await registryFor(data)).getOrCreate("ada");
      expect(engine.messages().map((message) => [message.role, message.content_blocks.map((block) => block.type)])).toEqual([["user", ["text"]], ["assistant", ["tool_use"]], ["user", ["tool_result"]], ["system", ["text"]]]);
      expect(warned.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("interrupted tool call"))).toEqual(["shore: recovered 1 interrupted tool call(s) for ada/main"]);
    } finally {
      warned.mockRestore();
    }
  });

  test("is not taken for one Shore stopped making while that reply is still running here", async () => {
    const data = join(mkdtempSync(testTmp("shore-interrupted-")), "data");
    mkdirSync(data, { recursive: true });
    const finished = markReplyRunning(data, "ada", "main");
    const engine = await (await registryFor(data)).getOrCreate("ada");
    expect([engine.messages(), running(data)]).toEqual([[], true]);
    finished();
    expect(running(data)).toBe(false);
  });

  test("goes on from what was saved of it when the user continues, without a new message from them, whether or not a tool round was saved", async () => {
    const at = new Date().toISOString();
    const said = (msg_id: string, role: "user" | "assistant" | "system", content: string, content_blocks: Message["content_blocks"]): Message => ({ msg_id, role, content, images: [], content_blocks, timestamp: at });
    const asked = said("m_asked", "user", "Look it up.", [{ type: "text", text: "Look it up." }]);
    const note = said("m_note", "system", INTERRUPTED_REPLY_NOTE, [{ type: "text", text: INTERRUPTED_REPLY_NOTE }]);
    const round = [
      said("m_used", "assistant", "", [{ type: "tool_use", id: "call", name: "read", input: { path: "notes.md" } }]),
      said("m_result", "user", "the notes", [{ type: "tool_result", tool_use_id: "call", content: "the notes" }]),
    ];
    const continued = async (thread: Message[]) => {
      const seen: SidecarRequest[] = [];
      const h = await reliabilityGeneration({
        generate: async () => { throw new Error("stream only"); },
        async *stream(request: SidecarRequest): AsyncIterable<StreamEvent> {
          seen.push(request);
          yield { type: "done", content: "Carrying on.", finish_reason: "end_turn", usage, timing };
        },
      });
      for (const message of thread) await h.engine.appendMessage(message);
      await h.run(new AbortController().signal, "");
      return [seen.map((request) => request.messages.map((message) => [message.role, message.content.map((block) => block.type === "text" ? block.text : block.type)])), h.engine.messages().map((message) => message.content).slice(-2)];
    };
    expect(await continued([asked, note])).toEqual([[[["user", ["Look it up."]], ["system", [INTERRUPTED_REPLY_NOTE]]]], [INTERRUPTED_REPLY_NOTE, "Carrying on."]]);
    expect(await continued([asked, ...round, note])).toEqual([[[["user", ["Look it up."]], ["assistant", ["tool_use"]], ["user", ["tool_result"]], ["system", [INTERRUPTED_REPLY_NOTE]]]], [INTERRUPTED_REPLY_NOTE, "Carrying on."]]);
  });
});
