import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Message } from "../src/engine/types.ts";
import { Mem0IngestService } from "../src/memory/mem0_ingest_service.ts";
import { testTmp } from "./support/tmp.ts";

function message(role: "user" | "assistant", id: string, text: string, timestamp: string): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp,
  };
}

const CONVERSATION = [
  message("user", "m1", "morning", "2026-01-01T10:00:00Z"),
  message("assistant", "m2", "morning to you", "2026-01-01T10:00:01Z"),
  message("user", "m3", "i bought a keychron", "2026-01-01T10:00:02Z"),
];

async function world(messages: Message[] = CONVERSATION): Promise<string> {
  const root = await mkdtemp(testTmp("shore-mem0-"));
  const dir = join(root, "ada");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "active.jsonl"),
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
  );
  return dir;
}

function recorder() {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    registry: {
      call: async (tool: string, args: unknown) => {
        calls.push({ tool, args: args as Record<string, unknown> });
        return "{}";
      },
    },
  };
}

describe("mem0 ingest service", () => {
  test("waits for the conversation to go idle", async () => {
    const dir = await world();
    const { calls, registry } = recorder();
    let clock = 1_000;
    const service = new Mem0IngestService({
      mcpRegistry: registry,
      now: () => clock,
      idleDelayMs: 30_000,
    });
    service.register({ character: "ada", characterDataDir: dir, server: "mem0" });
    service.noteMutation("ada");

    await service.runOnce();
    expect(calls).toHaveLength(0);

    clock += 30_000;
    await service.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("mcp__mem0__add");
    expect(calls[0]?.args["character"]).toBe("ada");
  });

  test("yields while a turn is in flight", async () => {
    const dir = await world();
    const { calls, registry } = recorder();
    const service = new Mem0IngestService({
      mcpRegistry: registry,
      now: () => 1_000_000,
      idleDelayMs: 0,
    });
    service.register({ character: "ada", characterDataDir: dir, server: "mem0" });
    service.noteMutation("ada");

    const endForeground = service.beginForeground();
    await service.runOnce();
    expect(calls).toHaveLength(0);

    endForeground();
    await service.runOnce();
    expect(calls).toHaveLength(1);
  });

  test("advances a cursor on disk and does not resend", async () => {
    const dir = await world();
    const { calls, registry } = recorder();
    const service = new Mem0IngestService({
      mcpRegistry: registry,
      now: () => 1_000_000,
      idleDelayMs: 0,
    });
    service.register({ character: "ada", characterDataDir: dir, server: "mem0" });
    service.noteMutation("ada");

    await service.runOnce();
    expect(JSON.parse(await readFile(join(dir, "mem0_cursor.json"), "utf8"))).toEqual({
      cursor: "2026-01-01T10:00:02Z",
    });

    await service.runOnce();
    expect(calls).toHaveLength(1);
    expect(service.progress("ada")?.pending).toBe(false);
  });

  test("a restarted service picks up where the cursor left off", async () => {
    const dir = await world();
    await writeFile(
      join(dir, "mem0_cursor.json"),
      JSON.stringify({ cursor: "2026-01-01T10:00:01Z" }),
    );
    const { calls, registry } = recorder();
    const service = new Mem0IngestService({
      mcpRegistry: registry,
      now: () => 1_000_000,
      idleDelayMs: 0,
    });
    service.register({ character: "ada", characterDataDir: dir, server: "mem0" });
    service.noteMutation("ada");

    await service.runOnce();
    const sent = calls[0]?.args["messages"] as { content: string }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toContain("i bought a keychron");
  });

  test("sends at most one batch per tick", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      message("user", `m${String(i)}`, `line ${String(i)}`, `2026-01-01T10:00:${String(i).padStart(2, "0")}Z`),
    );
    const dir = await world(many);
    const { calls, registry } = recorder();
    const service = new Mem0IngestService({
      mcpRegistry: registry,
      now: () => 1_000_000,
      idleDelayMs: 0,
      batchSize: 8,
    });
    service.register({ character: "ada", characterDataDir: dir, server: "mem0" });
    service.noteMutation("ada");

    await service.runOnce();
    expect(calls[0]?.args["messages"]).toHaveLength(8);
    await service.runOnce();
    expect(calls).toHaveLength(2);
  });

  test("backs off after a failure and keeps the work pending", async () => {
    const dir = await world();
    let clock = 1_000_000;
    let attempts = 0;
    const service = new Mem0IngestService({
      mcpRegistry: {
        call: async () => {
          attempts += 1;
          throw new Error("MCP server 'mem0' is unavailable");
        },
      },
      now: () => clock,
      idleDelayMs: 0,
    });
    service.register({ character: "ada", characterDataDir: dir, server: "mem0" });
    service.noteMutation("ada");

    await service.runOnce();
    expect(attempts).toBe(1);
    expect(service.progress("ada")).toMatchObject({
      failures: 1,
      pending: true,
      lastError: "MCP server 'mem0' is unavailable",
    });

    await service.runOnce();
    expect(attempts).toBe(1);

    clock += 60_000;
    await service.runOnce();
    expect(attempts).toBe(2);
  });

  test("holds back a reply that could still be regenerated", async () => {
    const dir = await world([
      ...CONVERSATION,
      message("assistant", "m4", "nice, which switches?", "2026-01-01T10:00:03Z"),
    ]);
    const { calls, registry } = recorder();
    const service = new Mem0IngestService({
      mcpRegistry: registry,
      now: () => 1_000_000,
      idleDelayMs: 0,
    });
    service.register({ character: "ada", characterDataDir: dir, server: "mem0" });
    service.noteMutation("ada");

    await service.runOnce();
    const sent = calls[0]?.args["messages"] as { content: string }[];
    expect(sent.map((m) => m.content).join(" ")).not.toContain("which switches");
    expect(sent).toHaveLength(3);
  });

  test("ingests nothing from a conversation the user has not spoken in", async () => {
    const dir = await world([message("assistant", "a1", "you awake?", "2026-01-01T09:00:00Z")]);
    const { calls, registry } = recorder();
    const service = new Mem0IngestService({
      mcpRegistry: registry,
      now: () => 1_000_000,
      idleDelayMs: 0,
    });
    service.register({ character: "ada", characterDataDir: dir, server: "mem0" });
    service.noteMutation("ada");

    await service.runOnce();
    expect(calls).toHaveLength(0);
  });

  test("stays inert until a registry is attached", async () => {
    const dir = await world();
    const service = new Mem0IngestService({ now: () => 1_000_000, idleDelayMs: 0 });
    service.register({ character: "ada", characterDataDir: dir, server: "mem0" });
    service.noteMutation("ada");

    await service.runOnce();
    expect(service.progress("ada")?.cursor).toBeUndefined();

    const { calls, registry } = recorder();
    service.attachRegistry(registry);
    await service.runOnce();
    expect(calls).toHaveLength(1);
  });
});
