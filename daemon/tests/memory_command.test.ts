import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import fixture from "./commands_fixtures/memory_command.json" with { type: "json" };

import { CommandError } from "../src/commands/errors.ts";
import { memory } from "../src/commands/memory.ts";
import { testTmp } from "./support/tmp.ts";

interface Row {
  name: string;
  note?: string;
  memory_dir_after: boolean;
  ok?: unknown;
  err?: { code: string; message: string };
}

const row = (section: "status" | "query", name: string): Row => {
  const found = (fixture[section] as unknown as Row[]).find((r) => r.name === name);
  if (found === undefined) throw new Error(`no fixture row named ${JSON.stringify(name)}`);
  return found;
};

type Entry = [path: string, text?: string];

async function build(entries: Entry[]): Promise<string> {
  const root = await mkdtemp(testTmp("shore-memory-cmd-"));
  for (const [path, text] of entries) {
    const target = join(root, path);
    if (path.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text ?? "");
  }
  await mkdir(join(root, "data"), { recursive: true });
  return root;
}

const isDir = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

function commandPrefix(message: string): string {
  const at = message.lastIndexOf("io: ");
  return at === -1 ? message : message.slice(0, at + "io: ".length);
}

async function check(r: Row, root: string, run: () => Promise<unknown>): Promise<void> {
  let result: unknown;
  let thrown: unknown;
  try {
    result = await run();
  } catch (e) {
    thrown = e;
  }

  if (r.err !== undefined) {
    expect(thrown, r.name).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).code, r.name).toBe(r.err.code as never);
    expect(commandPrefix((thrown as CommandError).message), r.name).toBe(
      commandPrefix(r.err.message),
    );
    expect(r.err.message.includes("io: "), r.name).toBe(true);
  } else {
    expect(thrown, r.name).toBeUndefined();
    expect(result, r.name).toEqual(r.ok as never);
  }
}

const furnished = (): Entry[] => [
  [
    "config/characters/mid/workspace/memory/projects.md",
    "The harbour project uses a tide table.\nSecond line about boats.\n",
  ],
  ["config/characters/mid/workspace/memory/people.md", "Ana sails on weekends.\n"],
  [
    "config/characters/mid/workspace/memory/daily.md",
    "A topic file whose name merely starts with the word daily.\n",
  ],
  [
    "config/characters/mid/workspace/memory/daily/2026-01-02.md",
    "Talked about the tide table again.\n",
  ],
  ["config/characters/mid/workspace/memory/daily/2026-01-03.md", "Nothing much.\n"],
  ["config/characters/mid/workspace/memory/images/harbour.md", "A photo of the harbour at dawn.\n"],
  [
    "config/characters/mid/workspace/memory/notes/daily/old.md",
    "Nested, so it is a topic file and not a daily one.\n",
  ],
  [
    "config/characters/mid/workspace/memory/scratch.txt",
    "The tide table, in a file the store ignores.\n",
  ],
];

const memoryDirOf = (root: string, character: string): string =>
  join(root, "config", "characters", character, "workspace", "memory");

type Case = [name: string, active: string, args: Record<string, unknown>, entries: Entry[]];

const STATUS: Case[] = [
  ["the three buckets, which always sum to the total", "mid", {}, furnished()],
  ["an empty store, which opening creates", "mid", {}, []],
  ["an empty query is status, not a search", "mid", { query: "" }, furnished()],
  ["a non-string query is status, not a search", "mid", { query: 7 }, furnished()],
  ["the store is the active character's own", "other", {}, furnished()],
  [
    "a memory directory that cannot be created",
    "mid",
    {},
    [["config/characters/mid/workspace", "not a dir"]],
  ],
  [
    "a memory path that is a file opens and then fails to list",
    "mid",
    {},
    [["config/characters/mid/workspace/memory", "not a dir"]],
  ],
];

const QUERY: Case[] = [
  ["a query matching two files, ranked", "mid", { query: "tide table" }, furnished()],
  ["matching is case-insensitive", "mid", { query: "TIDE" }, furnished()],
  ["a query matching nothing is not an error", "mid", { query: "submarine" }, furnished()],
  ["a query is not trimmed before it is echoed", "mid", { query: "  tide  " }, furnished()],
  ["a query against an empty store", "mid", { query: "anything" }, []],
  [
    "a search that cannot list the store",
    "mid",
    { query: "tide" },
    [["config/characters/mid/workspace/memory", "not a dir"]],
  ],
  ["images and daily files are searched like any other", "mid", { query: "harbour" }, furnished()],
];

for (const [section, cases] of [
  ["status", STATUS],
  ["query", QUERY],
] as const) {
  describe(`memory ${section}`, () => {
    for (const [name, active, args, entries] of cases) {
      test(name, async () => {
        const root = await build(entries);
        const r = row(section, name);
        await check(r, root, () => memory(join(root, "config"), active, args));
        expect(await isDir(memoryDirOf(root, active)), `${name} (memory_dir_after)`).toBe(
          r.memory_dir_after,
        );
      });
    }
  });
}
