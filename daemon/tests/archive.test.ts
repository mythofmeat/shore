import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportCharacter, importCharacter, type ArchiveContext } from "../src/commands/archive.ts";
import type { ShoreDirs } from "../src/config/dirs.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { Ledger } from "../src/ledger/store.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("character archives", () => {
  test("a compressed export restores one character without carrying another", async () => {
    const source = await root("source");
    await seedCharacter(source, "ada", "hello from ada");
    await seedCharacter(source, "bea", "hello from bea");
    const output = join(source.runtime, "ada.shore.tar.gz");
    const exported = await exportCharacter(context(source, new Set(["ada", "bea"])), {
      character: "ada",
      output,
    }) as Record<string, unknown>;
    expect(exported["bytes"]).toBeGreaterThan(0);

    const target = await root("target");
    let refreshed = false;
    const imported = await importCharacter(
      context(target, new Set(), () => {
        refreshed = true;
      }),
      { archive: output },
    ) as Record<string, unknown>;

    expect(imported["character"]).toBe("ada");
    expect(refreshed).toBe(true);
    expect(await readFile(join(target.workspace as string, "ada", "SOUL.md"), "utf8"))
      .toBe("You are ada.\n");
    expect(await readFile(join(target.data, "ada", "active.jsonl"), "utf8"))
      .toContain("hello from ada");
    const history = new Database(join(target.data, "history.db"), { readonly: true });
    expect(history.query("SELECT DISTINCT character FROM history_messages").values()).toEqual([
      ["ada"],
    ]);
    history.close();
  });

  test("import refuses an existing character before changing it", async () => {
    const source = await root("existing-source");
    await seedCharacter(source, "ada", "archive value");
    const output = join(source.runtime, "ada.shore.tar.gz");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });

    const target = await root("existing-target");
    await seedCharacter(target, "ada", "keep me");
    expect(importCharacter(context(target, new Set(["ada"])), { archive: output }))
      .rejects.toThrow("Refusing to overwrite");
    expect(await readFile(join(target.data, "ada", "active.jsonl"), "utf8")).toContain("keep me");
  });

  test("a hidden history conflict is preserved when import rolls back", async () => {
    const source = await root("hidden-source");
    await seedCharacter(source, "ada", "archive value");
    const output = join(source.runtime, "ada.shore.tar.gz");
    await exportCharacter(context(source, new Set(["ada"])), { character: "ada", output });

    const target = await root("hidden-target");
    const history = HistoryStore.open(join(target.data, "history.db"));
    history.putSegment(
      "ada",
      0,
      { file: "hidden.jsonl", message_count: 1, compacted_at: "2026-09-01T00:00:00Z" },
      [userMessage("ada", "hidden history")],
    );
    history.close();

    expect(importCharacter(context(target, new Set()), { archive: output }))
      .rejects.toThrow("history already exists");
    const preserved = new Database(join(target.data, "history.db"), { readonly: true });
    const count = preserved
      .query("SELECT COUNT(*) AS count FROM history_messages WHERE character = 'ada'")
      .get() as { count: number };
    expect(count.count).toBe(1);
    preserved.close();
  });
});

async function root(name: string): Promise<ShoreDirs> {
  const base = await mkdtemp(join(tmpdir(), `shore-${name}-`));
  roots.push(base);
  const dirs: ShoreDirs = {
    config: join(base, "config"),
    data: join(base, "data"),
    cache: join(base, "cache"),
    runtime: join(base, "runtime"),
    workspace: join(base, "workspace"),
  };
  await Promise.all(Object.values(dirs).map((path) => mkdir(path as string, { recursive: true })));
  Ledger.create(join(dirs.data, "ledger.db")).close();
  return dirs;
}

async function seedCharacter(dirs: ShoreDirs, character: string, text: string): Promise<void> {
  const workspace = join(dirs.workspace as string, character);
  const data = join(dirs.data, character);
  await mkdir(workspace, { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(join(dirs.config, "characters", character), { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), `You are ${character}.\n`);
  await writeFile(join(dirs.config, "characters", character, "config.toml"), "[defaults]\nstream = true\n");
  const message = userMessage(character, text);
  await writeFile(join(data, "active.jsonl"), `${JSON.stringify(message)}\n`);
  const history = HistoryStore.open(join(dirs.data, "history.db"));
  history.putSegment(
    character,
    0,
    { file: "segment-0.jsonl", message_count: 1, compacted_at: "2026-09-01T00:00:00Z" },
    [message],
  );
  history.close();
}

function userMessage(character: string, content: string): Message {
  return {
    msg_id: `m_${character}`,
    role: "user",
    content,
    content_blocks: [{ type: "text", text: content }],
    images: [],
    timestamp: "2026-09-01T00:00:00Z",
  };
}

function context(
  dirs: ShoreDirs,
  characters: Set<string>,
  refresh: () => void = () => {},
): ArchiveContext {
  return {
    dirs,
    hasCharacter: (name) => characters.has(name),
    withSnapshot: async (run) => await run(),
    refreshAfterImport: async () => {
      refresh();
    },
  };
}
