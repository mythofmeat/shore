import { extract } from "tar";
import { removeStoredCharacter } from "../src/storage/archive.ts";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCharacter, importCharacter, type ArchiveContext } from "../src/commands/archive.ts";
import { loadConfig } from "../src/config/loader.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { readThreadsIndex } from "../src/engine/threads.ts";
import { CallStore } from "../src/call_store.ts";
import { HeartbeatLog } from "../src/autonomy/heartbeat_log.ts";
import { bookPathIn, readBook, sessionKey } from "../src/llm/providers/agent_sessions.ts";
import { readSubagentTraces } from "../src/tools/subagent_trace.ts";
import { databasePath, withStorage } from "../src/storage/store.ts";
import { loadActivePromptFile } from "../src/memory/deferred_edits.ts";
import { attachmentCacheDir } from "../src/storage/image_cache.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("the oldest supported release's archive restores current data through the character flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-supported-baseline-"));
  roots.push(root);
  const dirs = {
    config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"),
    runtime: join(root, "runtime"), workspace: join(root, "workspace"),
  };
  await Promise.all(Object.values(dirs).map(directory => mkdir(directory, { recursive: true })));
  let refreshed = false;
  const context: ArchiveContext = {
    dirs, hasCharacter: () => false, withSnapshot: async run => await run(),
    refreshDiscovery: async () => { refreshed = true; }, releaseCharacter: async () => {},
  };
  const archive = join(import.meta.dir, "support/supported-baseline/ada.shore.tar.gz");
  expect(await importCharacter(context, { archive })).toMatchObject({ character: "ada", imported: true });
  expect(refreshed).toBe(true);
  expect(await readFile(join(dirs.workspace, "ada", "SOUL.md"), "utf8")).toBe("You are ada.\n");
  const loaded = loadConfig(join(dirs.config, "characters/ada/config.toml"), {
    env: { SHORE_CONFIG_DIR: dirs.config, SHORE_DATA_DIR: dirs.data, SHORE_CACHE_DIR: dirs.cache },
    onWarn: () => {},
  });
  expect(loaded.app.defaults.model).toBe("openai:gpt-test");
  expect((await readThreadsIndex(dirs.data, "ada"))?.home).toBe("main");
  const engine = await ConversationEngine.load("ada", dirs.data, undefined, "main");
  expect(engine.messages()).toHaveLength(1);
  expect(engine.messages()[0]?.content).toBe("saved conversation for ada");
  const image = join(attachmentCacheDir(dirs.cache, "ada"), "pixel.png");
  expect(engine.messages()[0]?.images[0]?.path).toBe(image);
  expect((await readFile(image)).subarray(1, 4).toString()).toBe("PNG");
  expect(existsSync(join(dirs.data, "media/ada/attachments"))).toBe(false);
  const path = databasePath(dirs.data);
  const history = HistoryStore.open(path);
  try {
    expect(history.readSegment("ada", 0)[0]?.content).toBe("saved conversation for ada");
    expect(history.segmentDisplayBounds("ada", 0)).toEqual({ start: 0, end: 1 });
    expect(history.archiveKeys("bea")).toEqual([]);
  } finally { history.close(); }
  const calls = CallStore.open(path);
  try {
    const rows = calls.queryCalls({ limit: 0 });
    expect(rows.map(row => row.call_id)).toEqual(["ada-call"]);
    expect(calls.getCall(rows[0]?.id ?? 0)).toMatchObject({ request: '{"request":"ada"}', response: '{"reply":"ada"}' });
  } finally { calls.close(); }
  withStorage(dirs.data, db => {
    expect(db.query("SELECT character, total_cost FROM calls").all()).toEqual([{ character: "ada", total_cost: 0.01 }]);
  });
  expect(readBook(bookPathIn(dirs.data))[sessionKey("ada", path, "main")]?.sessionId).toBe("ada-session");
  const character = join(dirs.data, "ada");
  expect(await loadActivePromptFile(character, "SOUL.md")).toBe("You are ada.\n");
  expect((await HeartbeatLog.load(join(character, "heartbeat.jsonl"))).recent(1)[0]?.detail).toBe("saved heartbeat");
  expect((await readSubagentTraces(character))[0]?.result).toBe("saved result");
  const currentArchive = join(root, "current.shore.tar.gz");
  await exportCharacter({ ...context, hasCharacter: () => true }, { character: "ada", output: currentArchive });
  const original = join(root, "original");
  await mkdir(original);
  await extract({ file: archive, cwd: original });
  const installedDirs = Object.fromEntries(Object.entries(dirs).map(([key, value]) => [key, `${value}-installed`])) as typeof dirs;
  await Promise.all(Object.values(installedDirs).map(directory => mkdir(directory, { recursive: true })));
  const installedPath = databasePath(installedDirs.data);
  await copyFile(join(original, "shore.db"), installedPath);
  expect((await ConversationEngine.load("ada", installedDirs.data)).messages()[0]?.content).toBe("saved conversation for ada");
  removeStoredCharacter(installedPath, "ada");
  await importCharacter({ ...context, dirs: installedDirs }, { archive: currentArchive });
  const installed = (await ConversationEngine.load("ada", installedDirs.data)).messages()[0];
  expect(installed?.content).toBe("saved conversation for ada");
  const installedImage = join(attachmentCacheDir(installedDirs.cache, "ada"), "pixel.png");
  expect(installed?.images[0]?.path).toBe(installedImage);
  expect((await readFile(installedImage)).subarray(1, 4).toString()).toBe("PNG");
  const installedCalls = CallStore.open(installedPath);
  try {
    expect(installedCalls.getCall(installedCalls.queryCalls({ limit: 1 })[0]?.id ?? 0)?.request).toBe('{"request":"ada"}');
  } finally { installedCalls.close(); }

});
