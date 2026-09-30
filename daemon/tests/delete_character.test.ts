import { writeDurable } from "../src/storage/files.ts";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteCharacter,
  importCharacter,
  type ArchiveContext,
} from "../src/commands/archive.ts";
import { discoverCharacters, type ShoreDirs } from "../src/config/dirs.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { Ledger } from "../src/ledger/store.ts";
import { outcomeOf } from "./support/outcome.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("deleting a character", () => {
  test("takes every path that would re-seed it, and its database rows", async () => {
    const dirs = await root("delete");
    await seedCharacter(dirs, "ada");
    await seedCharacter(dirs, "bea");
    const events: string[] = [];

    const result = (await deleteCharacter(context(dirs, new Set(["ada", "bea"]), events), {
      character: "ada",
      confirm: "ada",
    })) as { removed: string[]; deleted: boolean };

    expect(result.deleted).toBe(true);
    expect(result.removed.sort()).toEqual([
      join(dirs.cache, "characters", "ada"),
      join(dirs.config, "characters", "ada"),
      join(dirs.data, "ada"),
      join(dirs.workspace as string, "ada"),
    ]);
    for (const path of result.removed) expect(existsSync(path)).toBe(false);
    expect(discoverCharacters(dirs.config, dirs.workspace)).toEqual(["bea"]);

    const history = new Database(join(dirs.data, "shore.db"), { readonly: true });
    expect(
      history.query("SELECT DISTINCT character FROM history_messages ORDER BY character").values(),
    ).toEqual([["bea"]]);
    history.close();
    const ledger = new Database(join(dirs.data, "shore.db"), { readonly: true });
    expect(ledger.query("SELECT character FROM calls ORDER BY character").values())
      .toEqual([["bea"]]);
    ledger.close();
  });

  test("lets the daemon go first, and only then rescans", async () => {
    const dirs = await root("order");
    await seedCharacter(dirs, "ada");
    const events: string[] = [];

    await deleteCharacter(context(dirs, new Set(["ada"]), events), {
      character: "ada",
      confirm: "ada",
    });

    expect(events).toEqual(["snapshot", "release:ada", "refresh"]);
  });

  test("bea's data survives ada's deletion", async () => {
    const dirs = await root("neighbour");
    await seedCharacter(dirs, "ada");
    await seedCharacter(dirs, "adam");

    await deleteCharacter(context(dirs, new Set(["ada", "adam"]), []), {
      character: "ada",
      confirm: "ada",
    });

    expect(existsSync(join(dirs.workspace as string, "adam"))).toBe(true);
    expect(existsSync(join(dirs.data, "adam"))).toBe(true);
  });

  test("a workspace kept inside the config dir is removed once, with its parent", async () => {
    const dirs = await root("nested");
    delete (dirs as { workspace?: string }).workspace;
    await seedCharacter(dirs, "ada");

    const result = (await deleteCharacter(context(dirs, new Set(["ada"]), []), {
      character: "ada",
      confirm: "ada",
    })) as { removed: string[] };

    expect(result.removed).toEqual([
      join(dirs.config, "characters", "ada"),
      join(dirs.data, "ada"),
      join(dirs.cache, "characters", "ada"),
    ]);
    expect(existsSync(join(dirs.config, "characters", "ada"))).toBe(false);
  });

  test("data left behind by a character that no longer exists can still be cleared", async () => {
    const dirs = await root("orphan");
    await mkdir(join(dirs.data, "rhia", "threads", "main"), { recursive: true });

    const result = (await deleteCharacter(context(dirs, new Set(), []), {
      character: "rhia",
      confirm: "rhia",
    })) as { removed: string[] };

    expect(result.removed).toEqual([join(dirs.data, "rhia")]);
  });

  test("a name nothing knows about is a not-found, not a silent success", async () => {
    const dirs = await root("missing");

    expect(await outcomeOf(deleteCharacter(context(dirs, new Set(), []), { character: "ada", confirm: "ada" })))
      .toThrow("Character not found: ada");
  });

  test("without the name repeated back, nothing is touched", async () => {
    const dirs = await root("unconfirmed");
    await seedCharacter(dirs, "ada");
    const events: string[] = [];

    for (const confirm of [undefined, "", "yes", "Ada"]) {
      expect(
        await outcomeOf(deleteCharacter(context(dirs, new Set(["ada"]), events), { character: "ada", confirm })),
      ).toThrow("cannot be undone");
    }

    expect(events).toEqual([]);
    expect(existsSync(join(dirs.workspace as string, "ada"))).toBe(true);
  });

  test("--archive leaves a backup that imports back into a clean root", async () => {
    const dirs = await root("backup");
    await seedCharacter(dirs, "ada");
    const output = join(dirs.runtime, "ada.shore.tar.gz");

    const result = (await deleteCharacter(context(dirs, new Set(["ada"]), []), {
      character: "ada",
      confirm: "ada",
      archive: output,
    })) as { archive: string };

    expect(result.archive).toBe(output);
    expect(discoverCharacters(dirs.config, dirs.workspace)).toEqual([]);

    const restored = await root("restored");
    await importCharacter(context(restored, new Set(), []), { archive: output });
    expect(discoverCharacters(restored.config, restored.workspace)).toEqual(["ada"]);
  });

  test("a backup that cannot be written stops the deletion", async () => {
    const dirs = await root("failed-backup");
    await seedCharacter(dirs, "ada");

    expect(
      await outcomeOf(deleteCharacter(context(dirs, new Set(["ada"]), []), {
        character: "ada",
        confirm: "ada",
        archive: join(dirs.runtime, "no", "such", "dir", "ada.tar.gz"),
      })),
    ).toThrow("Archive directory does not exist");
    expect(existsSync(join(dirs.workspace as string, "ada"))).toBe(true);
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
  Ledger.create(join(dirs.data, "shore.db")).close();
  return dirs;
}

async function seedCharacter(dirs: ShoreDirs, character: string): Promise<void> {
  const workspace =
    dirs.workspace === undefined
      ? join(dirs.config, "characters", character, "workspace")
      : join(dirs.workspace, character);
  await mkdir(workspace, { recursive: true });
  await mkdir(join(dirs.data, character, "threads", "main"), { recursive: true });
  await mkdir(join(dirs.config, "characters", character), { recursive: true });
  await mkdir(join(dirs.cache, "characters", character), { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), `You are ${character}.\n`);
  await writeFile(join(dirs.cache, "characters", character, "history_search.db"), "");
  await writeFile(
    join(dirs.config, "characters", character, "config.toml"),
    "\n",
  );

  const message = userMessage(character);
  writeDurable(join(dirs.data, character, "threads", "main", "active.jsonl"), `${JSON.stringify(message)}\n`);
  const history = HistoryStore.open(join(dirs.data, "shore.db"));
  history.putSegment(
    character,
    0,
    { file: "segment-0.jsonl", message_count: 1, compacted_at: "2026-09-01T00:00:00Z" },
    [message],
  );
  history.close();

  const ledger = new Database(join(dirs.data, "shore.db"), { readwrite: true });
  ledger
    .query(
      `INSERT INTO calls
         (ts, character, provider, model, call_type, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_ms, ttft_ms, finish_reason,
          thinking_enabled, cache_state)
       VALUES (?1, ?2, 'anthropic', 'claude-opus-5', 'message', 5, 1, 0, 0, 10, 5,
               'end_turn', 0, 'warm')`,
    )
    .run("2026-09-01T00:00:00Z", character);
  ledger.close();
}

function userMessage(character: string): Message {
  return {
    msg_id: `m_${character}`,
    role: "user",
    content: `hello from ${character}`,
    content_blocks: [{ type: "text", text: `hello from ${character}` }],
    images: [],
    timestamp: "2026-09-01T00:00:00Z",
  };
}

function context(dirs: ShoreDirs, characters: Set<string>, events: string[]): ArchiveContext {
  return {
    dirs,
    hasCharacter: (name) => characters.has(name),
    withSnapshot: async (run) => {
      events.push("snapshot");
      return await run();
    },
    refreshDiscovery: async () => {
      events.push("refresh");
    },
    releaseCharacter: async (name) => {
      events.push(`release:${name}`);
    },
  };
}
