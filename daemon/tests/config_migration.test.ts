import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planMigration, validateMigration, type MigrationPlan } from "../src/config/migration.ts";
import { isConfigTable, putAt, removeAt, valueAt, type ConfigTable } from "../src/config/surface.ts";

function world(files: Record<string, string>, run: (root: string, plan: MigrationPlan) => void): void {
  const root = mkdtempSync(join(tmpdir(), "shore-config-migrate-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    mkdirSync(join(root, "data"), { recursive: true });
    const plan = planMigration(join(root, "config.toml"), join(root, "data"));
    run(root, plan);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (isConfigTable(value)) return `{ ${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)} = ${inline(child)}`).join(", ")} }`;
  return JSON.stringify(value);
}

function candidates(plan: MigrationPlan): Map<string, string> {
  return new Map(plan.files.map((file) => {
    const table = (file.kind === "threads" ? JSON.parse(file.before) : Bun.TOML.parse(file.before)) as ConfigTable;
    for (const edit of file.edits) {
      const value = edit.value ?? valueAt(table, edit.from ?? []);
      const existing = edit.to === undefined ? undefined : valueAt(table, edit.to);
      if (edit.from !== undefined) removeAt(table, edit.from, false);
      if (edit.to !== undefined) putAt(table, edit.to, edit.merge ? { ...(existing as ConfigTable), ...(value as ConfigTable) } : value);
    }
    const text = file.kind === "threads" ? JSON.stringify(table) : Object.entries(table).map(([key, value]) => `${JSON.stringify(key)} = ${inline(value)}\n`).join("");
    return [file.path, file.edits.length === 0 ? file.before : text];
  }));
}

describe("offline migration semantics", () => {
  test("numeric durations and legacy enum values become explicit without changing behavior", () => {
    world({
      "config.toml": '[behavior.autonomy.heartbeat]\nfallback_heartbeat_interval=3600\n[memory.thinking]\nreplay_prior_thinking=true\n[providers.gemini.defaults]\ncache_keepalive="disabled"\n[tools]\ntimeout=0\n',
      "data/preferences/models.toml": '[models."gemini:a.b"]\nreplay_prior_thinking=true\ncache_keepalive="none"\ngemini_generation=1\n',
      "conf.d/.hidden.toml": '[chat]\ndisplay_name="Hidden include"\n',
    }, (_root, plan) => {
      expect(plan.files.some((file) => file.path.endsWith("/.hidden.toml"))).toBe(true);
      const output = candidates(plan);
      expect(() => validateMigration(plan, output)).not.toThrow();
      const first = Bun.TOML.parse(output.get(plan.config) as string) as ConfigTable;
      expect(valueAt(first, ["heartbeat", "interval"])).toBe("1h");
      expect(valueAt(first, ["tools", "timeout"])).toBe("0s");
      expect(valueAt(first, ["chat", "reasoning_replay"])).toBe("all");
    });
  });

  test("converts source-owned settings, inherited exceptions, events, and preferences", () => {
    world({
      "config.toml": `include=["provider.toml"]
[defaults]
model="gemini:test"
[defaults.background]
model="gemini:background"
[behavior.autonomy]
enabled=true
[memory.compaction]
idle_trigger="50m"
min_turns=4
[notifications]
enabled=true
backend="ntfy"
[notifications.events]
error=true
[notifications.ntfy]
topic="private-test-topic"
[usage]
allow_compaction_over_budget=true
[[usage.budgets]]
cost_usd=15
warn_at=[0.9,1.0]
`,
      "provider.toml": '[providers.gemini.discovery]\nenabled=true\n[providers.gemini.defaults]\ntemperature=0.5\n',
      "characters/alex/config.toml": '[memory.compaction]\nkeep_recent_turns=0\n',
      "data/preferences/models.toml": '[models."gemini:test"]\nsdk="gemini"\ngemini_generation=1\nbudget_tokens=2048\n',
    }, (_root, plan) => {
      expect(plan.manual).toEqual([]);
      expect(plan.files).toHaveLength(4);
      expect(() => validateMigration(plan, candidates(plan))).not.toThrow();
      expect(plan.files.find((file) => file.path.endsWith("provider.toml"))?.edits.some((edit) => edit.to?.join(".") === "providers.gemini.temperature")).toBe(true);
    });
  });

  test("keeps character event patches and heartbeat gates equivalent", () => {
    world({
      "config.toml": '[behavior.autonomy]\nenabled=true\n[behavior.autonomy.heartbeat]\nenabled=false\n[notifications.events]\nerror=true\n',
      "characters/alex/config.toml": '[behavior.autonomy.heartbeat]\nenabled=true\n[notifications.events]\nerror=false\n',
    }, (_root, plan) => {
      expect(() => validateMigration(plan, candidates(plan))).not.toThrow();
    });
  });

  test("refuses a shared budget with different inherited character exceptions", () => {
    world({
      "config.toml": '[[usage.budgets]]\ncost_usd=5\n',
      "characters/alex/config.toml": '[usage]\nallow_compaction_over_budget=true\n',
    }, (_root, plan) => {
      expect(() => validateMigration(plan, candidates(plan))).toThrow("character alex");
    });
  });

  test("catalog aliases update selection, favorites, and thread pins", () => {
    world({
      "config.toml": '[defaults]\nmodel="fast"\n[providers.gemini]\n[chat.gemini.fast]\nmodel_id="test.v3"\nmax_output_tokens=1234\n',
      "data/preferences/models.toml": 'favorites=["chat.gemini.fast"]\n',
      "data/alex/threads.json": JSON.stringify({ version: 1, home: "main", threads: [{ id: "main", chat_model: "fast", compaction: true }] }),
    }, (_root, plan) => {
      expect(plan.manual).toEqual([]);
      const after = candidates(plan);
      expect(() => validateMigration(plan, after)).not.toThrow();
      expect(after.get(plan.files.find((file) => file.kind === "threads")?.path ?? "")).toContain("gemini:test.v3");
    });
  });

  test("favorite aliases compare as the normalized set stored by preferences", () => {
    world({
      "config.toml": '[defaults]\nmodel="first"\n[chat.gemini.first]\nmodel_id="z-model"\n[chat.gemini.second]\nmodel_id="a-model"\n',
      "data/preferences/models.toml": 'favorites=["first", "second", "chat.gemini.first"]\n',
    }, (_root, plan) => {
      expect(() => validateMigration(plan, candidates(plan))).not.toThrow();
    });
  });

  test("catalog conversion refuses to silently change the implicit first chat model", () => {
    world({
      "config.toml": '[chat.gemini.first]\nmodel_id="z-model"\n[chat.gemini.second]\nmodel_id="a-model"\n',
    }, (_root, plan) => {
      expect(() => validateMigration(plan, candidates(plan))).toThrow("changes effective global configuration");
    });
  });

  test("nonempty tokens and reserved definitions require manual work", () => {
    world({ "config.toml": '[notifications.ntfy]\ntoken="secret-test-token"\n[subagents.model]\ndescription="legacy"\nprompt="p"\n' }, (_root, plan) => {
      expect(plan.manual).toHaveLength(2);
      expect(plan.manual.join("\n")).not.toContain("secret-test-token");
      expect(() => validateMigration(plan, candidates(plan))).toThrow("manual actions");
    });
  });

  test("detects changed sources, permissions, and newly included files", () => {
    for (const change of ["content", "mode", "new-file"]) world({ "config.toml": '[defaults]\ndisplay_name="Alex"\n' }, (root, plan) => {
      const after = candidates(plan);
      if (change === "content") writeFileSync(join(root, "config.toml"), '[chat]\ndisplay_name="Sam"\n');
      if (change === "mode") chmodSync(join(root, "config.toml"), 0o600);
      if (change === "new-file") { mkdirSync(join(root, "conf.d")); writeFileSync(join(root, "conf.d", "added.toml"), '[chat]\ndisplay_name="Sam"\n'); }
      expect(() => validateMigration(plan, after)).toThrow("changed since planning");
    });
  });

  test("planning leaves all files and permissions unchanged", () => {
    world({ "config.toml": '[defaults]\ndisplay_name="Alex"\n' }, (root, plan) => {
      expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(plan.files[0]?.before ?? "");
      expect(() => validateMigration(plan, candidates(plan))).not.toThrow();
      expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(plan.files[0]?.before ?? "");
      symlinkSync(join(root, "config.toml"), join(root, "linked.toml"));
      expect(() => planMigration(join(root, "linked.toml"), join(root, "data"))).toThrow("symlink");
    });
  });

  test("a shadowed invalid source cannot be hidden by a valid overlay", () => {
    expect(() => world({
      "config.toml": 'include=["later.toml"]\n[providers.gemini.defaults]\ntemperatur=1\n',
      "later.toml": '[providers.gemini]\ntemperature=0.5\n',
    }, () => {})).toThrow("unknown field");
  });
});
