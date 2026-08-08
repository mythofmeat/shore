/**
 * The assembly that runs once, before anything is served.
 *
 * Almost nothing here is a decision, so almost nothing here is worth asserting
 * for its own sake. What is worth asserting is the handful of places where
 * getting the assembly wrong produces no error at all:
 *
 * - **The ledger file.** `ledgerFor` memoises a failed open, so a ledger that
 *   was never created is not one lost row — it is every row for the life of the
 *   process, and the only symptom is `shore usage` reporting a quiet month.
 * - **The call store.** The opposite rule: it must *not* be fatal. A daemon
 *   that will not start because payload capture failed has traded a diagnostic
 *   for the service.
 * - **The keepalive's sender.** It has to be the same adapter table chat sends
 *   through. A ping through a different one warms a prefix nothing will read.
 * - **The refusing executor.** A handler built without a runtime can track the
 *   schedule and cannot act on it, and the difference between refusing and
 *   throwing is whether the latch releases.
 */

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
import type { LoadedConfig } from "../src/config/loader.ts";
import type { SidecarProvider } from "../src/llm/types.ts";

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

/** A provider that records what it was asked to send and answers nothing real. */
function recordingProvider(seen: string[]): SidecarProvider {
  return {
    generate: (req: { model: string }) => {
      seen.push(req.model);
      return Promise.reject(new Error("no upstream in this test"));
    },
    stream: () => {
      throw new Error("not used");
    },
  } as unknown as SidecarProvider;
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
      // Not because anything writes to it, but because it is the root relative
      // `[mcp.*]` paths resolve against — discoverable without the docs.
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

      const path = join(config.dirs.data, "ledger.db");
      expect(existsSync(path)).toBe(true);

      // Created, not merely touched: `Ledger.open` on a file without the schema
      // is the same silent failure as no file at all.
      const { Ledger } = await import("../src/ledger/store.ts");
      const ledger = Ledger.open(path);
      expect(ledger.database.query("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 0 });
      ledger.close();

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a call store that will not open leaves the runtime up, without capture", async () => {
    const { root, config } = await dirsUnder("shore-runtime-store-");
    try {
      // A directory where the store expects a file. SQLite cannot open it, and
      // the daemon has to come up anyway — capture is a diagnostic, not the
      // service.
      await mkdir(config.dirs.cache, { recursive: true });
      await mkdir(join(config.dirs.cache, "calls.db"), { recursive: true });

      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });
      expect(runtime.callStore).toBeUndefined();

      await runtime.shutdown();
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

      // Arming takes the cadence beside the body, which is why the cache is
      // built after the keepalive and holds it rather than the other way round.
      runtime.cache.set("ada", {
        model: "claude-fixture",
        sdk: "anthropic",
        messages: [],
        context: { character: "ada", ledger: join(config.dirs.data, "ledger.db"), call_type: "message" },
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
        context: { character: "ada", ledger: join(config.dirs.data, "ledger.db"), call_type: "message" },
      } as never, undefined);

      const outcome = await runtime.keepalive.pingNow("ada");
      expect(JSON.stringify(outcome)).toContain("unsupported sdk");

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a heartbeat's message is filed under autonomous_message, not another toggle", () => {
    // The event name is the decision: every other toggle is a switch the user
    // set for something else, and filing under one of those makes the setting
    // they did reach for do nothing.
    const events: string[] = [];
    const notify = autonomousMessageNotifier({
      notify: (event: string) => events.push(event),
    } as never);

    notify("Shore — ada", "thinking about the tide");
    expect(events).toEqual(["autonomous_message"]);
  });

  test("an archived conversation is filed under compaction_complete", () => {
    const events: string[] = [];
    const notify = compactionCompleteNotifier({
      notify: (event: string) => events.push(event),
    } as never);

    notify("Shore — ada", "Idle conversation archived (12 messages, no LLM pass needed)");
    expect(events).toEqual(["compaction_complete"]);
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
  test("rotation runs at once rather than an hour after startup", async () => {
    const { root, config } = await dirsUnder("shore-runtime-rotate-");
    try {
      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });

      const rotated: { cutoff: Date; max: number }[] = [];
      const store = runtime.callStore;
      expect(store).toBeDefined();
      // Spy on the real store rather than a double: the immediate first pass is
      // the behaviour, and a daemon restarted after a long gap should not carry
      // a fortnight of stale rows until the next hour comes round.
      (store as unknown as { rotate: unknown }).rotate = (cutoff: Date, max: number) => {
        rotated.push({ cutoff, max });
        return { deleted_by_age: 0, deleted_by_size: 0 };
      };

      const clocks = startRuntimeClocks(runtime);
      clocks.stop();

      expect(rotated.length).toBe(1);
      const ageDays = (Date.now() - (rotated[0] as { cutoff: Date }).cutoff.getTime()) / 86_400_000;
      expect(Math.round(ageDays)).toBe(14);
      expect(rotated[0]?.max).toBe(536_870_912);

      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a rotation that throws does not take the daemon down with it", async () => {
    const { root, config } = await dirsUnder("shore-runtime-rotfail-");
    try {
      const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });
      (runtime.callStore as unknown as { rotate: unknown }).rotate = () => {
        throw new Error("database is locked");
      };

      expect(() => startRuntimeClocks(runtime).stop()).not.toThrow();

      await runtime.shutdown();
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
        // A path rather than a bare name, so the base it resolves against is
        // observable: `[mcp.*]` paths are documented as relative to
        // `<data>/plugins`, and resolving them anywhere else is a server that
        // will not start with a config that looks right.
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
      // `env` is a Map on one side and a plain object on the other; a Map that
      // arrives unconverted spreads to `{}` and the server starts without its
      // token, which looks like an auth failure in the server's own logs.
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
});
