import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autonomousMessageNotifier,
  compactionCompleteNotifier,
  createRuntime,
  startRuntimeClocks,
} from "../src/runtime.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ZERO_USAGE } from "../src/call_store.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { SidecarProvider } from "../src/llm/types.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import { HistoryIndexService } from "../src/memory/history_index_service.ts";
import type { McpClient } from "../src/mcp/client.ts";
import type { RecoveryWait } from "../src/tools/mcp_registry.ts";

async function dirsUnder(prefix: string): Promise<{ root: string; config: LoadedConfig }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const app = defaultAppConfig();
  return {
    root,
    config: {
      app,
      models: emptyCatalog(),
      providers: ProviderRegistry.empty(),
      dirs: {
        config: join(root, "config"),
        data: join(root, "data"),
        cache: join(root, "cache"),
        runtime: join(root, "runtime"),
      },
      rawTable: undefined,
    },
  };
}

function recordingProvider(seen: string[]): SidecarProvider {
  return {
    generate: (req: { model: string }) => {
      seen.push(req.model);
      return Promise.reject(new Error("no upstream in this test"));
    },
    stream: () => {
      throw new Error("not used");
    },
  };
}

const NO_MCP = () => Promise.reject(new Error("no MCP server should be connected"));

describe("what assembly creates", () => {
  test("the four runtime directories exist afterwards, plugins included", async () => {
    const { root, config } = await dirsUnder("shore-runtime-dirs-");
    try {
      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });

      for (const dir of [config.dirs.data, config.dirs.cache, config.dirs.runtime]) {
        expect(existsSync(dir)).toBe(true);
      }
      expect(existsSync(join(config.dirs.data, "plugins"))).toBe(true);

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the ledger exists with its schema, so the first recorded call has somewhere to go", async () => {
    const { root, config } = await dirsUnder("shore-runtime-ledger-");
    try {
      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });

      const path = join(config.dirs.data, "shore.db");
      expect(existsSync(path)).toBe(true);

      const { Ledger } = await import("../src/ledger/store.ts");
      const ledger = Ledger.open(path);
      expect(ledger.database.query("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 0 });
      ledger.close();

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an inaccessible durable database refuses startup", async () => {
    const { root, config } = await dirsUnder("shore-runtime-store-");
    try {
      await mkdir(config.dirs.cache, { recursive: true });
      await mkdir(join(config.dirs.data, "shore.db"), { recursive: true });

      expect(createRuntime({ config, providers: {}, connectMcp: NO_MCP })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("what assembly wires together", () => {
  test("the keepalive pings through the same adapters chat sends through", async () => {
    const { root, config } = await dirsUnder("shore-runtime-ping-");
    try {
      const seen: string[] = [];
      const runtime = await createRuntime({
        config,
        providers: { anthropic: recordingProvider(seen) },
        connectMcp: NO_MCP,
      });

      runtime.cache.set("ada", {
        model: "claude-fixture",
        sdk: "anthropic",
        messages: [],
        context: { character: "ada", ledger: join(config.dirs.data, "shore.db"), call_type: "message" },
      } as never, undefined);

      await runtime.keepalive.pingNow("ada");
      expect(seen).toEqual(["claude-fixture"]);

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an sdk with no adapter is a thrown ping rather than a silent no-op", async () => {
    const { root, config } = await dirsUnder("shore-runtime-nosdk-");
    try {
      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });

      runtime.cache.set("ada", {
        model: "claude-fixture",
        sdk: "anthropic",
        messages: [],
        context: { character: "ada", ledger: join(config.dirs.data, "shore.db"), call_type: "message" },
      } as never, undefined);

      const outcome = await runtime.keepalive.pingNow("ada");
      expect(JSON.stringify(outcome)).toContain("unsupported sdk");

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a heartbeat's message is filed under autonomous_message, not another toggle", () => {
    const events: string[] = [];
    const notify = autonomousMessageNotifier({
      notify: (event: string) => events.push(event),
    });

    notify("Shore - ada", "thinking about the tide");
    expect(events).toEqual(["autonomous_message"]);
  });

  test("an archived conversation is filed under compaction_complete", () => {
    const events: string[] = [];
    const notify = compactionCompleteNotifier({
      notify: (event: string) => events.push(event),
    });

    notify("Shore - ada", "Idle conversation archived (12 messages, no LLM pass needed)");
    expect(events).toEqual(["compaction_complete"]);
  });

  test("startup registers each character's history index once, not twice", async () => {
    const { root, config } = await dirsUnder("shore-runtime-once-");
    type Register = (
      this: HistoryIndexService,
      registration: Parameters<HistoryIndexService["register"]>[0],
    ) => void;
    const proto = HistoryIndexService.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "register")?.value as Register;
    const registered: string[] = [];
    proto.register = function (this: HistoryIndexService, registration) {
      registered.push(registration.character);
      original.call(this, registration);
    };
    try {
      for (const character of ["ada", "bo"]) {
        const workspace = join(config.dirs.config, "characters", character, "workspace");
        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, "SOUL.md"), `# ${character}`);
      }

      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });
      expect(registered).toEqual(["ada", "bo"]);

      await runtime.shutdown();
    } finally {
      proto.register = original;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("history registrations and tool contexts stay anchored to main when heartbeat home moves", async () => {
    const { root, config } = await dirsUnder("shore-runtime-history-home-");
    try {
      const workspace = join(config.dirs.config, "characters", "ada", "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "SOUL.md"), "# ada");
      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });
      try {
        await runtime.registry.createThread("ada", "side");
        await runtime.registry.setHomeThread("ada", "side");
        await runtime.refreshHistoryIndexes();
        const main = join(config.dirs.data, "ada", "threads", "main");
        expect(runtime.historyIndex.registeredCharacters()).toEqual(["ada"]);
        expect(runtime.historyIndex.progress("ada")?.conversationDir).toBe(main);
        const ctx = await buildToolContext(config, config.dirs.data, "ada");
        expect(ctx.conversationDir).toBe(main);
        expect(ctx.characterName).toBe("ada");
      } finally {
        await runtime.shutdown();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retain registration follows the configured characters without a second index pass", async () => {
    const { root, config } = await dirsUnder("shore-runtime-retain-");
    try {
      const workspace = join(config.dirs.config, "characters", "ada", "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "SOUL.md"), "# ada");

      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });
      expect(runtime.memoryRetain.registeredCharacters()).toEqual([]);

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("characters on disk are discovered by the registry the executor holds", async () => {
    const { root, config } = await dirsUnder("shore-runtime-chars-");
    try {
      const workspace = join(config.dirs.config, "characters", "ada", "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "SOUL.md"), "# ada");

      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });
      expect(runtime.registry.availableCharacters()).toEqual(["ada"]);

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the clocks", () => {
  test("diagnostic retention runs at startup and periodically, and stops with the clocks", async () => {
    const { root, config } = await dirsUnder("shore-runtime-rotate-");
    try {
      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });

      const store = runtime.callStore;
      if (store === undefined) throw new Error("missing call store");
      const record = () => store.recordCall({ call_id: "old", ts: new Date(0), usage: ZERO_USAGE, request_body: "diagnostic" });
      record();
      const clocks = startRuntimeClocks(runtime, { diagnosticRetentionMs: 5 });
      try {
        await Bun.sleep(15);
        expect(store.callCount()).toBe(0);
        record();
        await Bun.sleep(15);
        expect(store.callCount()).toBe(0);
        clocks.stop();
        record();
        await Bun.sleep(15);
        expect(store.callCount()).toBe(1);
      } finally {
        clocks.stop();
        await runtime.shutdown();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retention failures do not take down the daemon and a later sweep retries", async () => {
    const { root, config } = await dirsUnder("shore-runtime-rotfail-");
    try {
      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });
      const store = runtime.callStore;
      if (store === undefined) throw new Error("missing call store");
      store.recordCall({ call_id: "old", ts: new Date(0), usage: ZERO_USAGE, request_body: "diagnostic" });
      store.database.run("CREATE TRIGGER fail_retention BEFORE DELETE ON capture_calls BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
      const clocks = startRuntimeClocks(runtime, { diagnosticRetentionMs: 5 });
      try {
        await Bun.sleep(15);
        expect(store.callCount()).toBe(1);
        store.database.run("DROP TRIGGER fail_retention");
        await Bun.sleep(15);
        expect(store.callCount()).toBe(0);
      } finally {
        clocks.stop();
        await runtime.shutdown();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MCP configuration crosses the two shapes intact", () => {
  test("the env map becomes a record and absent transports stay absent", async () => {
    const { root, config } = await dirsUnder("shore-runtime-mcp-");
    try {
      config.app.mcp.set("hue", {
        command: "./hue/hue-mcp",
        args: ["--verbose"],
        env: new Map([["HUE_TOKEN", "secret"]]),
        cwd: undefined,
        url: undefined,
        headers: new Map(),
      });

      const specs: unknown[] = [];
      const runtime = await createRuntime({
        config,
        providers: {},
        connectMcp: (spec) => {
          specs.push(spec);
          return Promise.reject(new Error("not connecting in this test"));
        },
      });

      expect(specs.length).toBe(1);
      expect(JSON.parse(JSON.stringify(specs[0]))).toMatchObject({
        transport: {
          kind: "stdio",
          command: join(config.dirs.data, "plugins", "hue", "hue-mcp"),
          env: { HUE_TOKEN: "secret" },
        },
      });

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a recovered tool surface invalidates cached prompt bodies", async () => {
    const { root, config } = await dirsUnder("shore-runtime-mcp-recovery-");
    try {
      const workspace = join(config.dirs.config, "characters", "ada", "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "SOUL.md"), "# ada");
      config.app.mcp.set("hue", {
        command: "hue-server",
        args: [],
        env: new Map(),
        cwd: undefined,
        url: undefined,
        headers: new Map(),
      });
      config.app.tools.enabled_tools = ["mcp__hue__*"];

      let healthy = false;
      let releaseRetry!: () => void;
      const recoveryWait: RecoveryWait = (_ms, signal) =>
        new Promise((resolve) => {
          const finish = (): void => {
            signal.removeEventListener("abort", finish);
            resolve();
          };
          releaseRetry = finish;
          signal.addEventListener("abort", finish, { once: true });
        });
      const connect = (spec: { name: string }): Promise<McpClient> => {
        if (!healthy) return Promise.reject(new Error("hue is starting"));
        return Promise.resolve({
          server: spec.name,
          listTools: () =>
            Promise.resolve([
              {
                server: spec.name,
                name: "set_light",
                description: "set a light",
                input_schema: {},
              },
            ]),
          call: () => Promise.resolve(null),
          shutdown: () => Promise.resolve(),
        } as unknown as McpClient);
      };
      const runtime = await createRuntime({
        config,
        providers: {},
        connectMcp: connect,
        mcpRegistryOptions: {
          recoveryWait,
          random: () => 0.5,
        },
      });
      runtime.cache.set("ada", {
        model: "fixture",
        sdk: "anthropic",
        messages: [],
      } as never);
      expect(runtime.cache.get("ada")).toBeDefined();

      healthy = true;
      releaseRetry();
      for (let attempt = 0; attempt < 100 && runtime.mcp.current.connectedServers() === 0; attempt += 1) {
        await Promise.resolve();
      }

      expect(runtime.mcp.current.allTools().map((tool) => tool.full_name)).toEqual([
        "mcp__hue__set_light",
      ]);
      expect(runtime.cache.get("ada")).toBeUndefined();
      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
