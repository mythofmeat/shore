import { compareByCodePoint } from "../util/sort.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { acquireDataDirectoryLease, type DataDirectoryLease } from "../daemon/data_directory_lease.ts";
import { resolveShoreDirs, type ShoreDirs } from "./dirs.ts";
import { deepMerge, normalizeSource, parseConfigTable, type LoadedConfig } from "./loader.ts";
import { readPreferences } from "./preferences.ts";
import { serializeConfigValue } from "./serialize.ts";
import {
  BUDGET_ALIASES, CONFIG_ALIASES, CONFIG_FORMAT_VERSION, formatConfigPath, geminiMode,
  isConfigTable, legacyValues, matchingPaths, NOTIFICATION_EVENTS, publicConfig,
  putAt, REMOVED_CONFIG, removeAt, SETTING_ALIASES, translatePath, valueAt, type ConfigPath, type ConfigTable,
} from "./surface.ts";

export interface MigrationEdit {
  from?: string[];
  to?: string[];
  value?: unknown;
  merge?: boolean;
}

export interface MigrationFile {
  path: string;
  before: string;
  sha256: string;
  mode: number;
  kind: "config" | "preferences" | "threads";
  character?: string;
  edits: MigrationEdit[];
}

export interface MigrationPlan {
  version: number;
  config: string;
  data_dir: string;
  files: MigrationFile[];
  manual: string[];
  notices: string[];
}

export function migrationHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readSource(path: string, kind: MigrationFile["kind"], character?: string): MigrationFile {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || realpathSync(absolute) !== absolute) throw new Error(`${absolute}: migration requires regular files without symlink components`);
  const before = readFileSync(absolute, "utf8");
  return { path: absolute, before, sha256: migrationHash(before), mode: stat.mode & 0o777, kind, ...(character === undefined ? {} : { character }), edits: [] };
}

function subdirectories(path: string): string[] {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) if (entry.isSymbolicLink()) throw new Error(`${join(path, entry.name)}: migration cannot safely enumerate character scopes through symlinks`);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareByCodePoint);
}

function parse(file: MigrationFile, contents?: ReadonlyMap<string, string>): ConfigTable {
  try {
    const text = contents?.get(file.path) ?? file.before;
    return (file.kind === "threads" ? JSON.parse(text) : Bun.TOML.parse(text)) as ConfigTable;
  }
  catch { throw new Error(`${file.path}: invalid TOML; fix the syntax before migration (source values omitted)`); }
}

function sourceTable(file: MigrationFile, contents?: ReadonlyMap<string, string>): ConfigTable {
  const input = parse(file, contents);
  delete input.include;
  return normalizeSource(input, file.path, () => {});
}

interface MigrationState {
  dirs: ShoreDirs;
  global: LoadedConfig;
  characters: Map<string, LoadedConfig>;
}

function configState(plan: MigrationPlan, contents?: ReadonlyMap<string, string>): MigrationState {
  const dirs = resolveShoreDirs({ ...process.env, SHORE_CONFIG_DIR: dirname(plan.config), SHORE_DATA_DIR: plan.data_dir });
  const globalTable: ConfigTable = {};
  for (const file of plan.files) if (file.kind === "config" && file.character === undefined) deepMerge(globalTable, sourceTable(file, contents));
  const global = parseConfigTable(globalTable, dirs, () => {}, [], true);
  const characters = new Map<string, LoadedConfig>();
  for (const file of plan.files) {
    if (file.kind !== "config" || file.character === undefined) continue;
    const table = structuredClone(globalTable);
    const overlay = sourceTable(file, contents);
    deepMerge(table, overlay);
    const character = parseConfigTable(table, dirs, () => {}, [], true);
    if (Array.isArray(valueAt(overlay, ["usage", "budgets"]))) for (const budget of character.app.usage.budgets) budget.character ??= file.character;
    characters.set(file.character, character);
  }
  return { dirs, global, characters };
}

function semantics(config: LoadedConfig): unknown {
  const app = publicConfig(serializeConfigValue(config.app) as ConfigTable);
  const chat = [...config.models.chat.values()].map(({ name: _name, qualifiedName: _qualified, ...model }) => serializeConfigValue(model));
  const first = config.models.chat.values().next().value;
  const implicitChatFallback = config.app.defaults.model === undefined && first !== undefined ? `${first.providerKey}:${first.modelId}` : null;
  return { app, implicitChatFallback, chat: chat.sort((a, b) => stable(a).localeCompare(stable(b))), embedding: serializeConfigValue(config.models.embedding), image: serializeConfigValue(config.models.imageGeneration), providers: serializeConfigValue(new Map(config.providers.entries())) };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isConfigTable(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(key === "geminiGeneration" ? geminiMode(value[key]) : value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function equivalent(before: LoadedConfig, after: LoadedConfig, aliases: ReadonlyMap<string, string>): boolean {
  const old = semantics(before) as ConfigTable;
  const app = old.app as ConfigTable;
  for (const path of referencePaths(app)) {
    const value = valueAt(app, path);
    if (typeof value === "string" && aliases.has(value)) putAt(app, path, aliases.get(value));
  }
  return stable(old) === stable(semantics(after));
}

function referencePaths(table: ConfigTable): string[][] {
  return [
    ["chat", "model"], ["embedding", "model"], ["image", "model"], ["heartbeat", "model"], ["compaction", "model"],
    ["subagents", "model"], ...matchingPaths(table, ["subagents", "*", "model"]),
  ];
}

function aliasMap(state: MigrationState): Map<string, string> {
  const refs = new Map<string, Set<string>>();
  for (const config of [state.global, ...state.characters.values()]) for (const model of config.models.chat.values()) {
    for (const name of [model.name, model.qualifiedName]) {
      const identities = refs.get(name) ?? new Set<string>();
      identities.add(`${model.providerKey}:${model.modelId}`);
      refs.set(name, identities);
    }
  }
  return new Map([...refs].flatMap(([key, values]) => values.size === 1 ? [[key, [...values][0] as string] as const] : []));
}

function buildEdits(file: MigrationFile, effective: LoadedConfig, aliases: ReadonlyMap<string, string>, manual: string[]): void {
  const original = parse(file);
  const table = structuredClone(original);
  const edit = (from: ConfigPath | undefined, to: ConfigPath | undefined, value?: unknown): void => {
    if (from !== undefined && valueAt(table, from) === undefined) return;
    const old = from === undefined ? undefined : valueAt(table, from);
    const existing = to === undefined ? undefined : valueAt(table, to);
    const merge = isConfigTable(old) && isConfigTable(existing) && Object.keys(old).every((key) => !Object.hasOwn(existing, key));
    if (existing !== undefined && !merge && formatConfigPath(from ?? []) !== formatConfigPath(to ?? [])) {
      manual.push(`${file.path}: ${formatConfigPath(to ?? [])} already exists; resolve this migration conflict`);
      return;
    }
    file.edits.push({ ...(from === undefined ? {} : { from: [...from] }), ...(to === undefined ? {} : { to: [...to] }), ...(value === undefined ? {} : { value }), ...(merge ? { merge: true } : {}) });
    if (from !== undefined) removeAt(table, from, false);
    if (to !== undefined) putAt(table, to, merge ? { ...existing, ...old } : value ?? old);
  };
  const settings = (path: string[]): void => {
    for (const rule of SETTING_ALIASES) {
      const from = [...path, ...rule.legacy];
      const value = valueAt(table, from);
      edit(from, [...path, ...rule.canonical], rule.legacy[0] === "gemini_generation" ? geminiMode(value) : undefined);
    }
  };
  if (file.kind === "threads") {
    for (const path of matchingPaths(table, ["threads", "*", "chat_model"])) {
      const value = valueAt(table, path);
      if (typeof value === "string" && aliases.has(value) && aliases.get(value) !== value) edit(path, path, aliases.get(value));
    }
    return;
  }
  if (file.kind === "preferences") {
    for (const path of [["defaults", "sampler"], ...matchingPaths(table, ["models", "*"]), ...matchingPaths(table, ["subagent_models", "*"]), ...matchingPaths(table, ["subagents", "*"])]) settings(path);
    for (const change of legacyValues(table, true)) edit(change.path, change.path, change.value);
    for (const path of matchingPaths(table, ["favorites", "*"])) {
      const value = valueAt(table, path);
      if (typeof value === "string" && aliases.has(value) && aliases.get(value) !== value) edit(path, path, aliases.get(value));
    }
    return;
  }
  for (const reserved of ["enabled", "model"]) if (isConfigTable(valueAt(table, ["subagents", reserved]))) manual.push(`${file.path}: rename the legacy subagent ${reserved} and its grants before migration; that name is reserved`);
  for (const reserved of ["enabled", "timeout", "max_result_chars"]) if (valueAt(table, ["tools", "config", reserved]) !== undefined) manual.push(`${file.path}: rename the legacy tool override ${reserved}; that name is reserved`);
  const token = valueAt(table, ["notifications", "ntfy", "token"]);
  if (token !== undefined && token !== "") manual.push(`${file.path}: move the literal ntfy token into an environment variable, set notifications.token_env, and remove notifications.ntfy.token; secret omitted`);
  else edit(["notifications", "ntfy", "token"], undefined);
  for (const rule of REMOVED_CONFIG) edit(rule.path, undefined);
  const heartbeatGates = [["behavior", "autonomy", "enabled"], ["behavior", "autonomy", "heartbeat", "enabled"]];
  if (heartbeatGates.some((path) => valueAt(table, path) !== undefined)) {
    const owner = heartbeatGates.find((path) => valueAt(table, path) !== undefined) as string[];
    for (const path of heartbeatGates) if (path !== owner) edit(path, undefined);
    edit(owner, ["heartbeat", "enabled"], effective.app.behavior.autonomy.enabled && effective.app.behavior.autonomy.heartbeat.enabled);
  }
  const notifications = valueAt(table, ["notifications"]);
  if (isConfigTable(notifications)) {
    if (notifications.enabled !== undefined || notifications.backend !== undefined) {
      const owner = notifications.enabled !== undefined ? ["notifications", "enabled"] : ["notifications", "backend"];
      if (owner[1] === "enabled") edit(["notifications", "backend"], undefined);
      edit(owner, ["notifications", "via"], effective.app.notifications.enabled ? effective.app.notifications.backend : "off");
    }
    if (isConfigTable(notifications.events)) edit(["notifications", "events"], ["notifications", "events"], NOTIFICATION_EVENTS.filter((key) => effective.app.notifications.events[key]));
  }
  if (valueAt(table, ["defaults", "background", "model"]) !== undefined) {
    const fallback = valueAt(table, ["defaults", "background", "model"]);
    edit(["defaults", "background", "model"], undefined);
    for (const task of ["heartbeat", "compaction"] as const) if (effective.app.defaults.background[task] === undefined) edit(undefined, [task, "model"], fallback);
  }
  edit(["usage", "allow_compaction_over_budget"], undefined);
  for (const path of matchingPaths(table, ["providers", "*", "defaults", "*"])) edit(path, [path[0] as string, path[1] as string, path[3] as string]);
  for (const rule of CONFIG_ALIASES) for (const path of matchingPaths(table, rule.legacy)) edit(path, translatePath(path, rule.legacy, rule.canonical));
  for (const path of matchingPaths(table, ["budgets", "*"])) {
    for (const rule of BUDGET_ALIASES) edit([...path, ...rule.legacy], [...path, ...rule.canonical]);
    if (valueAt(table, [...path, "allow_compaction"]) === undefined && effective.app.usage.allow_compaction_over_budget) edit(undefined, [...path, "allow_compaction"], true);
  }
  if (valueAt(table, ["web_search", "depth"]) === "ultra-fast") edit(["web_search", "depth"], ["web_search", "depth"], "ultra_fast");
  for (const path of matchingPaths(table, ["providers", "*"])) settings(path);
  for (const section of ["chat", "embedding", "image"]) for (const path of matchingPaths(table, [section, "*"])) {
    if (!isConfigTable(valueAt(table, path))) continue;
    if (path[1]?.includes(":")) { settings(path); continue; }
    if (section !== "chat") continue;
    for (const old of matchingPaths(table, [...path, "*"])) {
      const entry = valueAt(table, old);
      if (!isConfigTable(entry)) continue;
      if (typeof entry.model_id !== "string") { manual.push(`${file.path}: ${formatConfigPath(old)} needs model_id in its owning source before migration`); continue; }
      if (entry.api_key_env !== undefined || entry.base_url !== undefined) { manual.push(`${file.path}: move ${formatConfigPath(old)} transport overrides to a distinct provider before migration`); continue; }
      const identity = `${path[1]}:${entry.model_id}`;
      edit([...old, "model_id"], undefined);
      settings(old);
      edit(old, ["chat", identity]);
    }
  }
  for (const change of legacyValues(table)) edit(change.path, change.path, change.value);
  for (const path of referencePaths(table)) {
    const value = valueAt(table, path);
    if (typeof value === "string" && aliases.has(value) && aliases.get(value) !== value) edit(path, path, aliases.get(value));
  }
}

export function planMigration(configPath: string, dataDir?: string): MigrationPlan {
  const config = resolve(configPath);
  const dirs = resolveShoreDirs(process.env);
  const plan: MigrationPlan = { version: CONFIG_FORMAT_VERSION, config, data_dir: resolve(dataDir ?? dirs.data), files: [], manual: [], notices: [] };
  const root = readSource(config, "config");
  plan.files.push(root);
  const includes = parse(root).include;
  if (includes !== undefined && (!Array.isArray(includes) || includes.some((value) => typeof value !== "string"))) throw new Error(`${config}: include must be a list of paths`);
  for (const include of (includes ?? []) as string[]) plan.files.push(readSource(resolve(dirname(config), include), "config"));
  const confD = join(dirname(config), "conf.d");
  if (existsSync(confD)) for (const name of readdirSync(confD).filter((entry) => entry.endsWith(".toml") && entry !== ".toml").sort(compareByCodePoint)) plan.files.push(readSource(join(confD, name), "config"));
  const characters = new Set([...subdirectories(join(dirname(config), "characters")), ...subdirectories(plan.data_dir)]);
  for (const character of characters) {
    const path = join(dirname(config), "characters", character, "config.toml");
    if (existsSync(path)) plan.files.push(readSource(path, "config", character));
  }
  for (const [path, character] of [[join(plan.data_dir, "preferences", "models.toml"), undefined], ...[...characters].map((name) => [join(plan.data_dir, name, "preferences", "models.toml"), name])] as [string, string | undefined][]) if (existsSync(path)) plan.files.push(readSource(path, "preferences", character));
  if (new Set(plan.files.map((file) => file.path)).size !== plan.files.length) throw new Error("a source file is loaded more than once; remove duplicate includes before migration");
  for (const character of characters) {
    const index = join(plan.data_dir, character, "threads.json");
    if (existsSync(index)) plan.files.push(readSource(index, "threads", character));
  }
  const state = configState(plan);
  const aliases = aliasMap(state);
  for (const file of plan.files) buildEdits(file, state.characters.get(file.character ?? "") ?? state.global, aliases, plan.manual);
  if (plan.files.some((file) => file.kind === "config" && valueAt(parse(file), ["usage", "allow_compaction_over_budget"]) !== undefined)) plan.notices.push("The global compaction budget exception is removed; future budgets use allow_compaction = false unless explicitly set.");
  return plan;
}

export function validateMigration(plan: MigrationPlan, contents: ReadonlyMap<string, string>): void {
  if (plan.manual.length > 0) throw new Error("manual actions remain; no files may be written");
  const fresh = planMigration(plan.config, plan.data_dir);
  if (stable(fresh.files.map((file) => [file.path, file.sha256, file.mode])) !== stable(plan.files.map((file) => [file.path, file.sha256, file.mode]))) throw new Error("source files or include graph changed since planning; start again");
  const before = configState(plan);
  const after = configState(plan, contents);
  const aliases = aliasMap(before);
  for (const file of plan.files) {
    if (!contents.has(file.path)) throw new Error(`${file.path}: candidate missing`);
    const current = readSource(file.path, file.kind, file.character);
    if (current.sha256 !== file.sha256 || current.mode !== file.mode) throw new Error(`${file.path}: changed since planning; start again`);
    if (file.kind === "preferences") {
      const oldPreferences = readPreferences(parse(file));
      const newPreferences = readPreferences(parse(file, contents));
      if ("ok" in oldPreferences) oldPreferences.ok.favorites = [...new Set(oldPreferences.ok.favorites.map((name) => aliases.get(name) ?? name))].sort(compareByCodePoint);
      if ("err" in oldPreferences || "err" in newPreferences || stable(serializeConfigValue(oldPreferences.ok)) !== stable(serializeConfigValue(newPreferences.ok))) throw new Error(`${file.path}: preference migration changes behavior or is invalid`);
    }
    if (file.kind === "config" && stable(parse(file).include) !== stable(parse(file, contents).include)) throw new Error(`${file.path}: migration changed include order`);
    if (file.kind === "threads") {
      const original = parse(file);
      for (const path of matchingPaths(original, ["threads", "*", "chat_model"])) {
        const name = valueAt(original, path);
        if (typeof name === "string") putAt(original, path, aliases.get(name) ?? name);
      }
      if (stable(original) !== stable(parse(file, contents))) throw new Error(`${file.path}: migration changed thread data beyond model pins`);
    }
  }
  if (!equivalent(before.global, after.global, aliases)) throw new Error("migration changes effective global configuration; separate inherited settings explicitly before migration");
  for (const [name, config] of before.characters) {
    const candidate = after.characters.get(name);
    if (candidate === undefined || !equivalent(config, candidate, aliases)) throw new Error(`migration changes effective configuration for character ${name}; make its inherited settings explicit before migration`);
  }
  for (const file of plan.files) {
    const candidate = { ...file, before: contents.get(file.path) as string, edits: [] };
    const manual: string[] = [];
    buildEdits(candidate, after.characters.get(file.character ?? "") ?? after.global, aliasMap(after), manual);
    if (candidate.edits.length > 0 || manual.length > 0) throw new Error(`${file.path}: candidate is not fully migrated`);
  }
}

export async function runMigrationHelper(): Promise<void> {
  let plan: MigrationPlan | undefined;
  let candidates: Map<string, string> | undefined;
  let lease: DataDirectoryLease | undefined;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      try {
        const request: unknown = JSON.parse(line);
        if (!isConfigTable(request) || request.version !== CONFIG_FORMAT_VERSION) throw new Error("incompatible configuration migration protocol");
        let result: unknown;
        switch (request.action) {
          case "plan":
            if (typeof request.config !== "string") throw new Error("config path required");
            plan = planMigration(request.config, typeof request.data_dir === "string" ? request.data_dir : undefined);
            result = plan;
            break;
          case "validate":
            if (plan === undefined || !isConfigTable(request.files) || Object.values(request.files).some((value) => typeof value !== "string")) throw new Error("plan and candidate files required");
            candidates = new Map(Object.entries(request.files) as [string, string][]);
            validateMigration(plan, candidates);
            result = { valid: true };
            break;
          case "acquire":
            if (plan === undefined || candidates === undefined) throw new Error("validate candidates before writing");
            lease = acquireDataDirectoryLease(plan.data_dir, { instanceId: "config-migration", startedAt: new Date().toISOString() });
            validateMigration(plan, candidates);
            result = { acquired: true };
            break;
          case "release":
            lease?.release();
            lease = undefined;
            result = { released: true };
            break;
          default: throw new Error("unknown migration action");
        }
        process.stdout.write(`${JSON.stringify({ version: CONFIG_FORMAT_VERSION, ok: result })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ version: CONFIG_FORMAT_VERSION, error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }
  } finally { lease?.release(); input.close(); }
}
