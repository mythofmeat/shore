import { readdir } from "./support/stored_files.ts";
import { readFile } from "./support/stored_files.ts";
import { required } from "../src/util/required.ts";

import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir,  writeFile } from "node:fs/promises";
import { join } from "node:path";

import rawFixture from "./memory_captures/compaction_assembly.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { renderToolOutcome } from "../src/memory/compaction/run.ts";
import { resolvePromptTemplate } from "../src/config/dirs.ts";
import { defaultAppConfig, defaultCompactionConfig, resolveDisplayName } from "../src/config/app.ts";
import { emptyCatalog, toRequestModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { configView, resolveBackgroundModel } from "../src/config/preferences.ts";
import { findEffectiveModel } from "../src/config/effective_catalog.ts";
import { InvalidArgs, ToolIoError } from "../src/tools/errors.ts";
import { testTmp } from "./support/tmp.ts";

const STAMP = "2026-01-01T00:00:00-05:00";
const NEW_ID = "11111111-2222-4333-8444-555555555555";

const FIXTURE_MODEL = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "anthropic",
  sdk: "anthropic",
  modelId: "claude-fixture",
  apiKeyEnv: "SHORE_FIXTURE_API_KEY",
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
  maxToolIterations: 7,
} as never;

async function tempRoot(): Promise<string> {
  return await mkdtemp(testTmp("shore-compaction-"));
}

function msgIds(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      try {
        return (JSON.parse(l) as { msg_id?: string }).msg_id ?? l;
      } catch {
        return l;
      }
    });
}

describe("archiveAndRetain", () => {
  for (const c of fixture.archive_and_retain) {
    test(c.name, async () => {
      const input = c.input as Record<string, unknown>;
      const out = c.output as Record<string, unknown>;
      const root = await tempRoot();
      const characterDir = join(root, "ada");
      await mkdir(join(characterDir, "threads", "main"), { recursive: true });

      await writeFile(
        join(characterDir, "threads", "main", "active.jsonl"),
        input["on_disk_differs"] === true
          ? `${input["active_content"] as string}${extraLine()}`
          : (input["active_content"] as string),
      );
      if (input["existing_manifest"] !== null) {
        await writeFile(
          join(characterDir, "threads", "main", "compaction.json"),
          JSON.stringify(input["existing_manifest"], null, 2),
        );
      }

      const id = await archiveAndRetain(
        join(characterDir, "threads", "main"),
        input["keep_last_n"] as number,
        input["active_content"] as string,
        () => STAMP,
        () => NEW_ID,
      );

      expect(out["ok"]).toBe(true);
      expect(out["returns_uuid"]).toBe(true);
      expect(id).toBe(NEW_ID);

      const segmentsDir = join(characterDir, "threads", "main", "segments");
      let files: string[] = [];
      try {
        files = (await readdir(segmentsDir)).sort();
      } catch {
        files = [];
      }
      const segments = await Promise.all(
        files.map(async (file) => ({
          file,
          lines: msgIds(await readFile(join(segmentsDir, file), "utf8")),
        })),
      );
      expect(segments).toEqual(out["segments"] as { file: string; lines: string[] }[]);

      const manifestRaw = await readFile(join(characterDir, "threads", "main", "compaction.json"), "utf8").catch(
        () => undefined,
      );
      const manifest =
        manifestRaw === undefined ? null : normaliseStamps(JSON.parse(manifestRaw) as unknown);
      expect(manifest).toEqual(out["manifest"] ?? null);

      const raw = await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8");
      expect(msgIds(raw)).toEqual(out["retained"] as string[]);
      expect(raw).toBe(out["retained_raw"] as string);
    });
  }
});

function extraLine(): string {
  return (
    JSON.stringify({
      msg_id: "m_4",
      role: "user",
      content: "arrived late",
      images: [],
      content_blocks: [{ type: "text", text: "arrived late" }],
      timestamp: "2026-01-01T10:00:00-05:00",
    }) + "\n"
  );
}

function normaliseStamps(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normaliseStamps);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [
        k,
        k === "compacted_at" ? "<stamp>" : normaliseStamps(val),
      ]),
    );
  }
  return v;
}

describe("resolveCompactionDeps", () => {
  for (const c of fixture.resolve_compaction_deps) {
    test(c.name, async () => {
      const input = c.input as Record<string, unknown>;
      const out = c.output as Record<string, unknown>;
      const root = await tempRoot();
      const dirs = {
        config: join(root, "config"),
        data: join(root, "data"),
        cache: join(root, "cache"),
        runtime: join(root, "run"),
      };
      for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

      const charPrompts = join(dirs.config, "characters", "ada", "prompts");
      const globalPrompts = join(dirs.config, "prompts");
      await mkdir(charPrompts, { recursive: true });
      await mkdir(globalPrompts, { recursive: true });
      for (const file of input["templates_on_disk"] as string[]) {
        const global = file.startsWith("global:");
        const name = global ? file.slice("global:".length) : file;
        const body = global
          ? "# the global prompt"
          : "# ada's prompt";
        await writeFile(join(global ? globalPrompts : charPrompts, name), body);
      }

      const app = defaultAppConfig();
      const models = emptyCatalog();
      if (input["model_configured"] === true) {
        app.defaults.model = "fixture";
        models.chat.set("chat.fixture", FIXTURE_MODEL);
      }
      const config: LoadedConfig = {
        app,
        models,
        providers: ProviderRegistry.empty(),
        dirs,
        rawTable: undefined,
      };

      expect(resolvePromptTemplate(dirs.config, "ada", "compact.md") ?? null).toBe(
        out["prompt_template_override"] as string | null,
      );

      const model = resolveBackgroundModel(
        configView(config),
        "compaction",
        "ada",
        (v, cache, n, hidden) => findEffectiveModel(v, cache, n, hidden),
      );
      expect(model?.qualifiedName ?? null).toBe(out["model"] as string | null);
      expect(model?.maxToolIterations ?? null).toBe(out["max_tool_iterations"] as number | null);
      if (model !== undefined) {
        expect(toRequestModel(model).max_tool_iterations ?? null).toBe(
          out["max_tool_iterations"] as number | null,
        );
      }

      expect(resolveDisplayName(config.app.defaults)).toBe(out["display_name"] as string);
      expect(config.app.memory.compaction.min_turns).toBe(defaultCompactionConfig().min_turns);
      expect(config.app.memory.compaction.max_turns).toBe(defaultCompactionConfig().max_turns);
    });
  }
});

describe("renderToolOutcome", () => {
  const answers: Record<string, () => unknown> = {
    "a string result is the model's text as-is": () => "wrote memory/boats.md",
    "an object result is serialized": () => ({ written: ["a.md"], count: 1 }),
    "a number is serialized too": () => 42,
    "a failure is the error's own text, flagged": () => {
      throw new InvalidArgs("missing `path`");
    },
    "an io failure keeps its prefix": () => {
      throw new ToolIoError("permission denied");
    },
  };

  for (const c of fixture.dispatch_result_to_output) {
    test(c.name, async () => {
      const answer = required(answers[c.name]);
      const out = await renderToolOutcome(async () => answer());
      expect(out.output).toBe(c.output);
      expect(out.isError).toBe(c.is_error);
    });
  }
});
