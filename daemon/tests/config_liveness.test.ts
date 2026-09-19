import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  acceptedTopLevelSections,
  defaultAppConfig,
} from "../src/config/app.ts";
import { config, reportedSections, type ConfigContext } from "../src/commands/config.ts";
import { parseConfigTable, type LoadedConfig } from "../src/config/loader.ts";
import { resolveShoreDirs } from "../src/config/dirs.ts";

function contextWithRawTable(rawTable: Record<string, unknown>): ConfigContext {
  return {
    config: { app: defaultAppConfig(), rawTable } as unknown as LoadedConfig,
  } as ConfigContext;
}

const emptyConfigContext = (): ConfigContext => contextWithRawTable({});

const PARSER = "src/config/app.ts";

const READ_ELSEWHERE: Readonly<Record<string, string>> = {};

function sourceFiles(root: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (exts.some((ext) => entry.endsWith(ext))) out.push(path);
    }
  };
  walk(root);
  return out;
}

function leafPaths(value: unknown, path: string[] = []): string[] {
  if (value instanceof Map) return [];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [path.join(".")];
    return entries.flatMap(([key, child]) => leafPaths(child, [...path, key]));
  }
  return [path.join(".")];
}

function optionName(leaf: string): string {
  const parts = leaf.replace(/\.millis$/, "").split(".");
  return parts[parts.length - 1] as string;
}

const repo = join(import.meta.dir, "..", "..");

const corpus = [
  ...sourceFiles(join(repo, "daemon", "src"), [".ts"]),
  ...sourceFiles(join(repo, "client"), [".rs"]).filter((p) => !p.includes("/target/")),
]
  .filter((p) => !p.endsWith(PARSER.replace("/", "/")))
  .map((p) => ({ path: p.slice(repo.length + 1), text: readFileSync(p, "utf8") }))
  .filter((f) => f.path !== `daemon/${PARSER}`);

describe("every config option shore reports is one shore reads", () => {
  const leaves = leafPaths(defaultAppConfig());

  test("the walk found the config surface, not a fragment of it", () => {
    expect(leaves.length).toBeGreaterThan(50);
    expect(corpus.length).toBeGreaterThan(50);
  });

  for (const leaf of leaves) {
    test(leaf, () => {
      const name = optionName(leaf);
      const word = new RegExp(`\\b${name}\\b`);
      const readers = corpus.filter((f) => word.test(f.text)).map((f) => f.path);

      const excuse = READ_ELSEWHERE[leaf];
      if (excuse !== undefined) {
        expect(readers.length, `${leaf} is allowlisted but unread: ${excuse}`).toBeGreaterThan(0);
        return;
      }

      expect(
        readers.length,
        `\`${leaf}\` parses and shows up in \`shore config\`, but nothing outside ` +
          `${PARSER} mentions \`${name}\`. Either wire it up or delete it — a config ` +
          `option nobody reads is a promise shore does not keep.`,
      ).toBeGreaterThan(0);
    });
  }

  test("the allowlist only names options that still exist", () => {
    for (const leaf of Object.keys(READ_ELSEWHERE)) {
      expect(leaves, `${leaf} is allowlisted but is no longer a config option`).toContain(leaf);
    }
  });
});

describe("every section the daemon accepts is one shore config reports", () => {
  const accepted = [...acceptedTopLevelSections()].sort();

  test("the two sets are the same set", () => {
    expect([...reportedSections(emptyConfigContext())].sort()).toEqual(accepted);
  });

  test("a section the loader extracts is still readable", () => {
    const ctx = contextWithRawTable({
      providers: { anthropic: { api_key_env: "ANTHROPIC_API_KEY" } },
    });
    const read = config(ctx, { key: "providers.anthropic.api_key_env" }) as { config: unknown };
    expect(read.config).toBe("ANTHROPIC_API_KEY");
  });

  test("an unset extracted section reads as unset, not as absent", () => {
    const read = config(emptyConfigContext(), { key: "providers" }) as { config: unknown };
    expect(read.config).toEqual({});
  });

  test("the parser names every accepted section when it rejects one", () => {
    let err = "";
    try { parseConfigTable({ definitely_not_a_section: {} }, resolveShoreDirs({}), () => {}); }
    catch (error) { err = String(error); }
    for (const section of accepted) {
      expect(err, `the rejection does not mention \`${section}\``).toContain(`\`${section}\``);
    }
  });
});
