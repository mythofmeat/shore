import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TriggerFiring } from "../src/autonomy/runner.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import type { SubagentTurn } from "../src/handler/generation.ts";
import { ledgerFor } from "../src/ledger/record.ts";
import type { CallStore } from "../src/call_store.ts";
import { shoreLog } from "../src/log.ts";
import { sharedToolDeps, type SubagentToolDeps } from "../src/runtime.ts";
import type { ToolContext } from "../src/tools/dispatch.ts";
import type { McpHolder } from "../src/tools/mcp_holder.ts";
import * as subagentLoop from "../src/tools/subagent_loop.ts";
import { testTmp } from "./support/tmp.ts";

async function world(data?: (root: string) => Promise<string>): Promise<{ config: LoadedConfig; asked: TriggerFiring[]; deps: (sub?: Partial<SubagentToolDeps>) => ReturnType<typeof sharedToolDeps> }> {
  const root = await mkdtemp(testTmp("shore-tool-deps-"));
  await writeFile(join(root, "config.toml"), "");
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
  const mcp = { callView: () => ({ call: async () => "unused" }), current: { toolDefsFiltered: () => [] } } as unknown as McpHolder;
  return { config, asked, deps: (sub = {}) => sharedToolDeps(config, mcp, autonomy, { providers: {}, registry, ...sub }) };
}

test("a wake asked for in a thread the character has no such thread of is refused, and one in an open or sealed thread is queued", async () => {
  const { asked, deps } = await world();
  const wake = deps().wakeInThread;
  if (wake === undefined) throw new Error("the deps offer no wakeInThread");
  expect(wake("ada", "main", { thread: "nosuch", reason: "look", limitMs: undefined, overwrite: false })).toEqual({ kind: "no_thread" });
  expect(wake("ada", "main", { thread: "vault", reason: "look", limitMs: undefined, overwrite: false })).toMatchObject({ kind: "queued" });
  expect(wake("ada", "main", { thread: "ring", reason: "again", limitMs: undefined, overwrite: false })).toMatchObject({ kind: "queued" });
  expect(asked.map((firing) => [firing.thread, firing.reason])).toEqual([["vault", "look"], ["ring", "again"]]);
});

test("a sub-agent is run with the character's own config, the parent's tools and conversation, and the turn's frames, store and environment when there are any", async () => {
  const { config, deps } = await world();
  const seen: Record<string, unknown>[] = [];
  const runner = async (): Promise<string> => "answer";
  const made = spyOn(subagentLoop, "subagentRunner").mockImplementation((options) => { seen.push(options as unknown as Record<string, unknown>); return runner; });
  try {
    const parent = { characterName: "ada", conversation: [] } as unknown as ToolContext;
    const send = (): void => {};
    const now = (): string => "2026-11-27T00:00:00Z";
    const newMessageId = (): string => "m_1";
    const turn: SubagentTurn = { conversation: [], send, now, newMessageId, signal: new AbortController().signal };
    const store = {} as CallStore;
    const env = { SHORE_TOOL_DEPS: "1" };
    expect(deps().runSubagent?.(parent)).toBe(runner);
    deps({ callStore: store, env, turn: { ...turn, rid: "r_1" } }).runSubagent?.(parent);
    deps({ turn }).runSubagent?.(parent);
    expect(seen.map((options) => Object.keys(options).toSorted())).toEqual([
      ["config", "conversation", "ctx", "mcpRegistry", "providers"],
      ["callStore", "config", "conversation", "ctx", "env", "mcpRegistry", "newMessageId", "now", "providers", "rid", "sendDirect"],
      ["config", "conversation", "ctx", "mcpRegistry", "newMessageId", "now", "providers", "sendDirect"],
    ]);
    expect(seen[1]).toMatchObject({ config, ctx: parent, callStore: store, env, sendDirect: send, rid: "r_1", now, newMessageId });
  } finally {
    made.mockRestore();
  }
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
