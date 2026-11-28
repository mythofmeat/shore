import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TriggerFiring } from "../src/autonomy/runner.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import type { SubagentTurn } from "../src/handler/generation.ts";
import { ledgerFor } from "../src/ledger/record.ts";
import type { CallStore } from "../src/call_store.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { shoreLog } from "../src/log.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { sharedToolDeps, type SubagentToolDeps } from "../src/runtime.ts";
import { Texts } from "../src/texts/texts.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import type { McpHolder } from "../src/tools/mcp_holder.ts";
import { testTmp } from "./support/tmp.ts";

const KEY_ENV = "SHORE_TOOL_DEPS_KEY";

async function world(data?: (root: string) => Promise<string>, toml = ""): Promise<{ root: string; config: LoadedConfig; asked: TriggerFiring[]; deps: (sub?: Partial<SubagentToolDeps>) => ReturnType<typeof sharedToolDeps> }> {
  const root = await mkdtemp(testTmp("shore-tool-deps-"));
  await writeFile(join(root, "config.toml"), toml);
  const loaded = loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} });
  const config: LoadedConfig = { ...loaded, dirs: { ...loaded.dirs, data: data === undefined ? join(root, "data") : await data(root) } };
  const asked: TriggerFiring[] = [];
  const autonomy = {
    activityStats: () => { throw new Error("no call expected"); },
    wakesMayRun: () => true,
    requestWake: (_character: string, firing: TriggerFiring) => { asked.push(firing); return { kind: "queued", replaced: false } as const; },
  } as unknown as Parameters<typeof sharedToolDeps>[2];
  const registry = {
    effectiveConfig: () => config,
    listThreads: () => [{ id: "main" }, { id: "ring" }],
    sealedThreads: () => [{ id: "vault" }],
    wakesThread: () => "wakes",
    sealThread: () => { throw new Error("no call expected"); },
  } as unknown as SubagentToolDeps["registry"];
  const mcp = { callView: () => ({ call: async () => "unused" }), current: { toolDefsFiltered: () => [], namesMatching: () => [] } } as unknown as McpHolder;
  return { root, config, asked, deps: (sub = {}) => sharedToolDeps(config, mcp, autonomy, { providers: {}, registry, ...sub }) };
}

function answering(text: string, seen: SidecarRequest[]): SidecarProvider {
  async function* stream(request: SidecarRequest): AsyncGenerator<StreamEvent> {
    seen.push(request);
    yield { type: "start", model: request.model };
    yield { type: "text", text };
    yield {
      type: "done", content: text, finish_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 },
    };
  }
  return {
    stream,
    async *streamWithTools(request, phase) {
      await phase.runTool({ id: "t1", name: "read", input: { file_path: "nothing.md" } });
      yield* stream(request);
    },
    generate: () => { throw new Error("a sub-agent streams"); },
  };
}

test("a wake asked for in a thread the character has no such thread of is refused, and one in an open or sealed thread is queued", async () => {
  const { asked, deps } = await world();
  const wake = deps().wakeInThread;
  if (wake === undefined) throw new Error("the deps offer no wakeInThread");
  expect(wake("ada", "main", { thread: "nosuch", reason: "look", limitMs: undefined, overwrite: false, startsAt: undefined })).toEqual({ kind: "no_thread" });
  expect(wake("ada", "main", { thread: "vault", reason: "look", limitMs: undefined, overwrite: false, startsAt: undefined })).toMatchObject({ kind: "queued" });
  expect(wake("ada", "main", { thread: "ring", reason: "again", limitMs: undefined, overwrite: false, startsAt: 1_800_000_000_000 })).toMatchObject({ kind: "queued" });
  expect(asked.map((firing) => [firing.thread, firing.reason, firing.startsAt])).toEqual([["vault", "look", undefined], ["ring", "again", 1_800_000_000_000]]);
});

test("a sub-agent runs on the character's own config with the turn's frames, call store and environment, and a turn's signal, conversation and thread go to its tools", async () => {
  const { root, deps } = await world(undefined, [
    "[chat]", 'model = "openrouter:cheap"', "max_retries = 0", "[providers.openrouter]", `api_key_env = "${KEY_ENV}"`,
    "[subagents.scout]", 'description = "looks"', 'prompt = "look"', 'tools = ["read"]', "",
  ].join("\n"));
  await mkdir(join(root, "data", "ada", "threads", "main"), { recursive: true });
  const parent: ToolContext = {
    texts: new Texts(), userName: "eve", characterName: "ada", workspaceDir: join(root, "workspace"), characterDataDir: join(root, "data", "ada"),
    conversationDir: join(root, "data", "ada", "threads", "main"), historyDbPath: join(root, "data", "shore.db"), configDir: root, conversation: [],
  };
  const seen: SidecarRequest[] = [];
  const recorded: unknown[] = [];
  const frames: ServerMessage[] = [];
  const signal = new AbortController().signal;
  const turn: SubagentTurn = { conversation: [], send: (frame) => { frames.push(frame); }, now: () => "2026-11-27T00:00:00Z", newMessageId: () => "m_1", signal, rid: "r_1", thread: "ring" };
  const full = deps({
    providers: { openrouter: answering("found it", seen) }, env: { [KEY_ENV]: "sk-tool-deps" }, turn,
    callStore: { recordCall: (call: unknown) => { recorded.push(call); return 1; } } as unknown as CallStore,
  });
  const ask = full.runSubagent?.(parent);
  expect(await ask?.("scout", "where is it?")).toBe("found it");
  expect([seen.map((request) => [request.model, request.api_key]), recorded.length]).toEqual([[["cheap", "sk-tool-deps"]], 1]);
  expect(frames.some((frame) => "rid" in frame && frame.rid === "r_1")).toBe(true);
  expect([full.signal, full.conversation, full.thread]).toEqual([signal, turn.conversation, "ring"]);

  const bare = deps();
  expect([typeof bare.runSubagent?.(parent), "signal" in bare, "conversation" in bare, "thread" in bare]).toEqual(["function", false, false, false]);
  const { thread: _thread, ...unthreaded } = turn;
  expect("thread" in deps({ turn: unthreaded })).toBe(false);
});

test("the model history a tool asks for is the character's calls in the ledger, within the times asked for, and a ledger that can't be opened is said to be unavailable", async () => {
  const { config, deps } = await world(async (root) => { await mkdir(join(root, "data")); return join(root, "data"); });
  const ledger = ledgerFor(join(config.dirs.data, "shore.db"));
  if (ledger === null) throw new Error("the ledger did not open");
  const call = (model: string, character: string, at: string): void => {
    ledger.record({
      provider: "anthropic", model, call_type: "message", character, finish_reason: "end_turn", thinking_enabled: false,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 },
    }, () => new Date(at));
  };
  call("claude-early", "ada", "2026-11-01T00:00:00.000Z");
  call("claude-late", "ada", "2026-11-20T00:00:00.000Z");
  call("claude-other", "bo", "2026-11-05T00:00:00.000Z");
  const history = deps().modelHistoryQuery;
  if (history === undefined) throw new Error("the deps offer no modelHistoryQuery");
  const models = async (since?: string, until?: string): Promise<string[]> => (await history("ada", since, until)).map((row) => row.model);
  expect(await models()).toEqual(["claude-early", "claude-late"]);
  expect(await models("2026-11-10T00:00:00.000Z")).toEqual(["claude-late"]);
  expect(await models(undefined, "2026-11-10T00:00:00.000Z")).toEqual(["claude-early"]);

  const blocked = await world(async (root) => { await writeFile(join(root, "plain"), ""); return join(root, "plain", "data"); });
  const said = spyOn(shoreLog, "error").mockImplementation(() => {});
  try {
    let refused = "";
    try {
      void blocked.deps().modelHistoryQuery?.("ada", undefined, undefined);
    } catch (error) {
      refused = String(error);
    }
    expect(refused).toBe("Error: the ledger is unavailable");
  } finally {
    said.mockRestore();
  }
});
