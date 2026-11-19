import { afterEach, describe, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { registrationFor } from "../src/autonomy/registration.ts";
import { characterCacheDir, characterWorkspaceDir, pluginsDir } from "../src/config/dirs.ts";
import { historyIndexPath } from "../src/memory/history_index.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import { sha256Hex } from "../src/engine/picture_files.ts";
import type { ImageRef, Message } from "../src/engine/types.ts";
import { claudeLoginSettings } from "../src/ledger/plan_limits.ts";
import { prepareCallAccounting } from "../src/ledger/record.ts";
import { Ledger } from "../src/ledger/store.ts";
import type { SignInFlow } from "../src/llm/claude_sign_in.ts";
import { credentialStanding } from "../src/llm/credential_standing.ts";
import { nanoGptSubscriptionPath } from "../src/llm/nanogpt_subscription.ts";
import { secretStoreFor, storedSecret } from "../src/llm/secret_store.ts";
import { newWireScope, withWireScope } from "../src/llm/wire_capture.ts";
import { beginSignIn, pendingSignIn } from "../src/llm/sign_in.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import type { McpClient, McpServerSpec } from "../src/mcp/client.ts";
import type { McpRegistry } from "../src/tools/mcp_registry.ts";
import { createRuntime, type RuntimeOptions, type ShoreRuntime } from "../src/runtime.ts";
import { imageBlobDir } from "../src/storage/image_blobs.ts";
import { attachmentCacheDir } from "../src/storage/image_cache.ts";
import { providerCacheDir } from "../src/storage/provider_cache.ts";
import { noisePng } from "./support/test_images.ts";
import { testTmp } from "./support/tmp.ts";
import { until } from "./support/until.ts";

const running: ShoreRuntime[] = [];

afterEach(async () => {
  for (const runtime of running.splice(0)) await stop(runtime);
});

async function stop(runtime: ShoreRuntime): Promise<void> {
  await runtime.autonomy.shutdown();
  await runtime.shutdown();
}

async function install(toml = "", characters: readonly string[] = ["ada"], root?: string): Promise<LoadedConfig> {
  const at = root ?? await mkdtemp(testTmp("shore-runtime-"));
  const configDir = join(at, "config");
  await mkdir(configDir, { recursive: true });
  for (const name of characters) {
    const workspace = join(configDir, "characters", name, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), `# ${name}\n`);
  }
  await writeFile(join(configDir, "config.toml"), toml);
  return loadConfig(join(configDir, "config.toml"), {
    env: { SHORE_CONFIG_DIR: configDir, XDG_DATA_HOME: join(at, "data"), XDG_CACHE_HOME: join(at, "cache"), XDG_RUNTIME_DIR: join(at, "run") },
    onWarn: () => {},
  });
}

async function start(config: LoadedConfig, options: Partial<RuntimeOptions> = {}): Promise<ShoreRuntime> {
  const runtime = await createRuntime({ config, providers: {}, env: {}, ...options });
  running.push(runtime);
  return runtime;
}

async function stopped(runtime: ShoreRuntime): Promise<void> {
  running.splice(running.indexOf(runtime), 1);
  await stop(runtime);
}

async function put(path: string, bytes: Uint8Array): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function png(seed: number, size = 4): Promise<Buffer<ArrayBuffer>> {
  return Buffer.from(await noisePng(size, size, seed));
}

function shown(images: ImageRef[]): Message {
  return {
    msg_id: crypto.randomUUID(), role: "user", content: "look", images,
    content_blocks: [{ type: "text", text: "look" }], timestamp: "2026-10-01T10:00:00+10:00",
  };
}

function archive(data: string, messages: Message[]): void {
  mkdirSync(data, { recursive: true });
  const store = HistoryStore.open(join(data, "shore.db"));
  try {
    store.putSegment("ada", 0, { file: "0001.jsonl", compacted_at: "2026-10-01T11:00:00+10:00" }, messages);
  } finally {
    store.close();
  }
}

function archivedImages(data: string): ImageRef[] {
  const store = HistoryStore.open(join(data, "shore.db"));
  try {
    return store.readSegment("ada", 0).flatMap((message) => message.images);
  } finally {
    store.close();
  }
}

function query(data: string, sql: string): unknown[] {
  const db = new Database(join(data, "shore.db"), { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

function reply(request: SidecarRequest): GenerateResponse {
  return {
    content: "", content_blocks: [], finish_reason: "end_turn", model: request.model,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 100, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  };
}

function recording(sent: SidecarRequest[]): SidecarProvider {
  return {
    generate: (request) => {
      sent.push(request);
      return Promise.resolve(reply(request));
    },
    stream: () => {
      throw new Error("a keepalive ping doesn't stream");
    },
  };
}

function cachedPrefix(character: string, sdk: SidecarRequest["sdk"], intervalMs = 55 * 60_000) {
  return {
    sdk, model: "claude-x", api_key: "", max_tokens: 1, reasoning_replay: "all" as const,
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }, { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] }],
    keepalive_interval_ms: intervalMs, keepalive_pings: 3,
    context: { character, call_type: "message", thinking_enabled: false },
  };
}

describe("a runtime coming up", () => {
  test("makes the folders for its plugins and its runtime files", async () => {
    const config = await install();
    await start(config);
    expect([existsSync(pluginsDir(config.dirs.data)), existsSync(config.dirs.runtime)]).toEqual([true, true]);
  });

  test("rewrites a database an older version left, once, so that deleted rows give their space back", async () => {
    const config = await install();
    await mkdir(config.dirs.data, { recursive: true });
    const older = new Database(join(config.dirs.data, "shore.db"));
    older.run("CREATE TABLE older (x)");
    older.close();
    await start(config);
    expect(query(config.dirs.data, "PRAGMA auto_vacuum")).toEqual([{ auto_vacuum: 2 }]);
  });

  test("holds the image cache to image_cache_bytes, letting the least recently used pictures go first", async () => {
    const config = await install("[daemon]\nimage_cache_bytes = 1000\n");
    const dir = attachmentCacheDir(config.dirs.cache, "ada");
    const older = await put(join(dir, "20261101_090000_older.png"), Buffer.alloc(800, 1));
    const newer = await put(join(dir, "20261101_100000_newer.png"), Buffer.alloc(800, 2));
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    await utimes(older, hoursAgo(3), hoursAgo(3));
    await utimes(newer, hoursAgo(2), hoursAgo(2));
    await start(config);
    expect([existsSync(older), existsSync(newer)]).toEqual([false, true]);
  });

  test("moves an older version's attachments into the image cache, and archived messages show them from there", async () => {
    const config = await install();
    const cat = await png(1);
    const legacy = await put(join(config.dirs.data, "media", "ada", "attachments", "20260915_120000_cat.png"), cat);
    archive(config.dirs.data, [shown([{ path: legacy }])]);
    await start(config);
    expect(existsSync(legacy)).toBe(false);
    const [image] = archivedImages(config.dirs.data);
    expect(image?.path).toBe(join(attachmentCacheDir(config.dirs.cache, "ada"), "20260915_120000_cat.png"));
    expect(readFileSync(image?.path ?? "")).toEqual(cat);
  });

  test("points pictures that archived messages show at paths from an older layout to where they are now", async () => {
    const config = await install();
    const cat = await png(2);
    archive(config.dirs.data, [shown([{ path: "/home/someone/.local/share/shore/media/ada/attachments/20260901_090000_cat.png" }])]);
    const now = await put(join(attachmentCacheDir(config.dirs.cache, "ada"), "20260901_090000_cat.png"), cat);
    await start(config);
    expect(archivedImages(config.dirs.data).map((image) => image.path)).toEqual([now]);
  });

  test("keeps the pictures it archives from the image cache and the workspace opening after both folders move", async () => {
    const root = await mkdtemp(testTmp("shore-runtime-"));
    const before = await install("", ["ada"], join(root, "old"));
    const cat = await png(3);
    const drawing = await png(4);
    const attachment = await put(join(attachmentCacheDir(before.dirs.cache, "ada"), "20261001_100000_cat.png"), cat);
    const art = await put(join(characterWorkspaceDir(before.dirs.config, "ada", before.dirs.workspace), "art", "drawing.png"), drawing);
    const first = await start(before);
    archive(before.dirs.data, [shown([{ path: attachment, sha256: sha256Hex(cat) }]), shown([{ path: art, sha256: sha256Hex(drawing) }])]);
    await stopped(first);

    await rename(join(root, "old"), join(root, "new"));
    const after = await install("", ["ada"], join(root, "new"));
    await start(after);

    const images = archivedImages(after.dirs.data);
    expect(images.map((image) => image.path)).toEqual([
      join(attachmentCacheDir(after.dirs.cache, "ada"), "20261001_100000_cat.png"),
      join(characterWorkspaceDir(after.dirs.config, "ada", after.dirs.workspace), "art", "drawing.png"),
    ]);
    expect(images.map((image) => readFileSync(image.path))).toEqual([cat, drawing]);
  });

  test("moves the image data archived messages carry out of the database into the image cache", async () => {
    const config = await install();
    const picture = await png(5, 16);
    archive(config.dirs.data, [{
      ...shown([]),
      content_blocks: [{ type: "image", source: { type: "base64", media_type: "image/png", data: picture.toString("base64") } }],
    }]);
    await start(config);
    expect(readdirSync(imageBlobDir(config.dirs.cache, "ada"))).toEqual([`${sha256Hex(picture)}.png`]);
  });

  test("marks the calls its last run left pending as unresolved", async () => {
    const config = await install();
    await mkdir(config.dirs.data, { recursive: true });
    const path = join(config.dirs.data, "shore.db");
    Ledger.create(path, undefined, false).close();
    const db = new Database(path);
    db.query(
      "INSERT INTO call_attempts (id, started_at, status, character, provider, model, call_type) VALUES ('left', '2026-11-19T00:00:00Z', 'pending', 'ada', 'anthropic', 'claude-x', 'message')",
    ).run();
    db.close();
    await start(config);
    expect(query(config.dirs.data, "SELECT id, status FROM call_attempts")).toEqual([{ id: "left", status: "unresolved" }]);
  });

  test("removes the workspace index an older version kept in its cache", async () => {
    const config = await install();
    const dir = characterCacheDir(config.dirs.cache, "ada");
    const files = await Promise.all(["", "-wal", "-shm"].map(async (suffix) => await put(join(dir, `workspace_index.db${suffix}`), new Uint8Array())));
    await start(config);
    expect(files.filter((file) => existsSync(file))).toEqual([]);
  });

  test("takes the Claude logins' settings from its config", async () => {
    const config = await install('[providers.claude_agent]\npin = "work"\n\n[[providers.claude_agent.keys]]\nname = "work"\nweekly_limit = 0.5\n');
    await start(config);
    expect(claudeLoginSettings()).toEqual({ provider: "claude_agent", pin: "work", logins: [{ name: "work", enabled: true, limits: { weekly: 0.5 } }] });
  });

  test("reads the provider keys saved in its data folder", async () => {
    const config = await install();
    secretStoreFor(config.dirs.data).set("openai", "main", "sk-saved");
    await start(config);
    expect(storedSecret("openai", "main")).toBe("sk-saved");
  });

  test("remembers from its cache how its credentials last stood", async () => {
    const config = await install();
    await put(join(providerCacheDir(config.dirs.cache, "openai"), "credentials.json"), Buffer.from(JSON.stringify({
      credentials: { main: { standing: "invalid", detail: "401", checked_at: "2026-11-19T00:00:00Z" } },
    })));
    await start(config);
    expect(credentialStanding("openai", "main")?.standing).toBe("invalid");
  });

  test("indexes each character's history", async () => {
    const config = await install();
    await start(config);
    expect(existsSync(historyIndexPath(config.dirs.cache, "ada"))).toBe(true);
  });

  test("stops indexing the history of a character that's gone once it reloads", async () => {
    const config = await install("", ["ada", "bea"]);
    const runtime = await start(config);
    await rm(join(config.dirs.config, "characters", "bea"), { recursive: true });
    await runtime.registry.reloadRuntimeState(config);
    await runtime.refreshHistoryIndexes();
    expect(runtime.historyIndex.registeredCharacters()).toEqual(["ada"]);
  });
});

describe("a runtime's MCP servers", () => {
  test("changing their tools rebuilds the requests it had cached with them", async () => {
    const runtime = await start(await install('[chat]\nmodel = "anthropic:claude-x"\n[providers.anthropic]\napi_key_env = "SHORE_RUNTIME_KEY"\n[tools]\nenabled = ["notes__*"]\n'), { env: { SHORE_RUNTIME_KEY: "sk-from-env" } });
    const stale = cachedPrefix("ada", "anthropic");
    runtime.cache.set("ada", stale);
    await runtime.refreshMcpCaches({ toolDefsFiltered: () => [{ name: "notes__search", description: "Search the notes", input_schema: {} }] } as unknown as McpRegistry);
    expect(runtime.cache.get("ada")?.tools?.map((tool) => tool.name)).toEqual(["notes__search"]);
  });
});

describe("a runtime's keepalive", () => {
  test("pings through the provider for the request's sdk with the key from the runtime's environment, and fails a ping for an sdk with no provider", async () => {
    const config = await install('[providers.anthropic]\napi_key_env = "SHORE_RUNTIME_KEY"\n', ["ada", "bea"]);
    const sent: SidecarRequest[] = [];
    const runtime = await start(config, { providers: { anthropic: recording(sent) }, env: { SHORE_RUNTIME_KEY: "sk-from-env" } });
    runtime.keepalive.arm(cachedPrefix("ada", "anthropic"), true);
    runtime.keepalive.arm(cachedPrefix("bea", "openai"), true);
    const pinged = await runtime.keepalive.pingNow("ada");
    const unsupported = await runtime.keepalive.pingNow("bea");
    expect(pinged.status).toBe("sent");
    expect(sent.map((request) => [request.model, request.api_key])).toEqual([["claude-x", "sk-from-env"]]);
    expect(unsupported.status).toBe("failed");
    expect(unsupported.detail).toContain("unsupported sdk: openai");
  });

  test("puts each scheduled ping in the character's wake log", async () => {
    const config = await install('[providers.anthropic]\napi_key_env = "SHORE_RUNTIME_KEY"\n');
    const runtime = await start(config, { providers: { anthropic: recording([]) }, env: { SHORE_RUNTIME_KEY: "sk-from-env" } });
    await runtime.autonomy.register(registrationFor("ada", runtime.registry.effectiveConfig("ada")));
    runtime.keepalive.arm(cachedPrefix("ada", "anthropic", 1), true);
    await Bun.sleep(5);
    await runtime.keepalive.tick();
    expect(runtime.autonomy.log("ada", 10).map((event) => event.kind)).toContain("dormant_ping");
  });
});

describe("a runtime shutting down", () => {
  test("leaves no timer of its own behind", async () => {
    jest.useFakeTimers();
    try {
      const runtime = await createRuntime({ config: await install(), providers: {}, env: {} });
      runtime.cacheRefresh.refresh("ada", "compaction");
      await stop(runtime);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("shuts its MCP servers down", async () => {
    const config = await install('[mcp.notes]\nurl = "http://mcp.test"\n');
    const shutDown: string[] = [];
    const connectMcp = (spec: McpServerSpec): Promise<McpClient> => Promise.resolve({
      server: spec.name,
      listTools: () => Promise.resolve([]),
      call: () => Promise.resolve(null),
      shutdown: () => {
        shutDown.push(spec.name);
        return Promise.resolve();
      },
    } as unknown as McpClient);
    await stopped(await start(config, { connectMcp }));
    expect(shutDown).toEqual(["notes"]);
  });

  test("lets the runtime that comes after it record its own HTTP exchanges", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("pong") });
    try {
      await stopped(await start(await install()));
      const runtime = await start(await install());
      const scope = newWireScope("after", { character: "ada", call_type: "message" });
      expect(await withWireScope(scope, async () => await (await fetch(`http://127.0.0.1:${String(server.port)}/ping`)).text())).toBe("pong");
      await until(() => (runtime.callStore?.httpCallsFor("after").length ?? 0) > 0, "the exchange being recorded", 2_000);
      expect(runtime.callStore?.httpCallsFor("after").map((call) => call.url)).toEqual([`http://127.0.0.1:${String(server.port)}/ping`]);
    } finally {
      await server.stop(true);
    }
  });

  test("ends the sign-ins still waiting for their codes", async () => {
    const runtime = await start(await install());
    const ended: string[] = [];
    const flow = { close: () => { ended.push("flow"); } } as unknown as SignInFlow;
    await beginSignIn("claude_agent", "work", () => Promise.resolve({ flow, detail: "work" }), (detail) => { ended.push(detail); });
    await stopped(runtime);
    expect([ended, pendingSignIn("claude_agent", "work")]).toEqual([["flow", "work"], undefined]);
  });

  test("no longer keeps the NanoGPT subscription in its cache", async () => {
    const config = await install();
    await stopped(await start(config));
    let fetched = 0;
    const fetchImpl = (() => {
      fetched += 1;
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch;
    await prepareCallAccounting({ ...cachedPrefix("ada", "openai"), provider_key: "nanogpt" }, fetchImpl);
    expect([fetched, existsSync(nanoGptSubscriptionPath(config.dirs.cache))]).toEqual([0, false]);
  });
});
