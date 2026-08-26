import { describe, expect, test } from "bun:test";

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { testTmp } from "./support/tmp.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import { McpClient } from "../src/mcp/client.ts";
import { McpHolder } from "../src/tools/mcp_holder.ts";
import { McpRegistry, type McpServerConfigView } from "../src/tools/mcp_registry.ts";
import { dispatchWithinDeadline } from "../src/tools/dispatch.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";

const SERVER = join(import.meta.dir, "support", "mcp_side_effect_server.ts");

function configFor(root: string): LoadedConfig {
  return {
    app: defaultAppConfig(),
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs: {
      config: join(root, "config"),
      data: join(root, "data"),
      cache: join(root, "cache"),
      runtime: join(root, "runtime"),
    },
    rawTable: undefined,
  };
}

async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "the call somehow succeeded";
}

async function marks(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function settle(path: string, holdMs: number): Promise<string> {
  await new Promise((resolve) => {
    setTimeout(resolve, holdMs * 2);
  });
  return await marks(path);
}

async function liveContext(holdMs: number) {
  const root = await mkdtemp(testTmp("mcp-deadline-"));
  const marker = join(root, "side_effects.log");
  await writeFile(marker, "", "utf8");

  const servers: Record<string, McpServerConfigView> = {
    effects: {
      command: process.execPath,
      args: ["run", SERVER, marker, String(holdMs)],
    },
  };
  const registry = await McpRegistry.fromConfig(servers, root, McpClient.connect);
  const holder = new McpHolder(registry);
  const config = configFor(root);
  const ctx = await buildToolContext(config, config.dirs.data, "ada", {
    mcpRegistry: holder.callView(),
  });
  return { ctx, marker, shutdown: () => registry.shutdown() };
}

describe("MCP tool deadlines against a live server", () => {
  test("the deadline really stops the server's work, so no side effect runs", async () => {
    const live = await liveContext(1_500);
    try {
      const failure = await rejection(
        dispatchWithinDeadline("mcp__effects__obedient", {}, live.ctx, 100, 2_000),
      );
      expect(failure).toContain("timed out after 0s");

      const after = await settle(live.marker, 1_500);
      expect(after).toContain("cancelled");
      expect(after).not.toContain("side effect");
    } finally {
      await live.shutdown();
    }
  }, 20_000);

  test("even an obedient server's stop is reported as unconfirmed, because MCP cannot ack it", async () => {
    const live = await liveContext(1_500);
    try {
      expect(
        await rejection(
          dispatchWithinDeadline("mcp__effects__obedient", {}, live.ctx, 100, 2_000),
        ),
      ).toContain("it may still be running");
    } finally {
      await live.shutdown();
    }
  }, 20_000);

  test("a tool that ignores the cancel is reported as possibly still running", async () => {
    const live = await liveContext(1_500);
    try {
      expect(
        await rejection(
          dispatchWithinDeadline("mcp__effects__stubborn", {}, live.ctx, 100, 100),
        ),
      ).toContain("it may still be running");

      expect(await marks(live.marker)).toBe("");
      expect(await settle(live.marker, 1_500)).toContain("side effect: stubborn");
    } finally {
      await live.shutdown();
    }
  }, 20_000);

  test("a read-only tool times out without warning against repeating it", async () => {
    const live = await liveContext(1_500);
    try {
      const failure = await rejection(
        dispatchWithinDeadline("mcp__effects__lookup", {}, live.ctx, 100, 100),
      );
      expect(failure).toBe("timed out after 0s and was cancelled");
    } finally {
      await live.shutdown();
    }
  }, 20_000);

  test("a tool inside its deadline still returns its result over the real transport", async () => {
    const live = await liveContext(10);
    try {
      expect(
        await dispatchWithinDeadline("mcp__effects__obedient", {}, live.ctx, 5_000),
      ).toBe("done");
    } finally {
      await live.shutdown();
    }
  }, 20_000);
});
