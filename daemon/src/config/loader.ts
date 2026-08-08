import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { compareByCodePoint } from "../util/sort.ts";
import {
  budgetPeriodRank,
  normalizeDeprecatedAliases,
  parseAppConfig,
  validateCompaction,
  type AppConfig,
  type UsageBudgetConfig,
  type UsageConfig,
} from "./app.ts";
import {
  rustJoin,
  resolveShoreDirs,
  type Env,
  type HomeLookup,
  type ShoreDirs,
} from "./dirs.ts";
import { applyDotenv } from "./dotenv.ts";
import { rustTrim } from "./duration.ts";
import { catalogFromSections, findModel, CatalogError, type ModelCatalog } from "./models.ts";
import { ProviderRegistry, ProviderRegistryError } from "./providers.ts";
import { renderStarterConfig } from "./starter.ts";

export type TomlTable = Record<string, unknown>;

export interface RawConfigTable {
  table: TomlTable;
  dirs: ShoreDirs;
}

export type ConfigErrorKind =
  | "read_file"
  | "parse_app"
  | "parse_include"
  | "conf_d"
  | "catalog"
  | "provider_registry"
  | "validation";

export class ConfigError extends Error {
  readonly kind: ConfigErrorKind;
  readonly path: string | undefined;

  constructor(kind: ConfigErrorKind, message: string, path?: string) {
    super(message);
    this.name = "ConfigError";
    this.kind = kind;
    this.path = path;
  }

  get display(): string {
    switch (this.kind) {
      case "read_file":
        return `failed to read ${this.path}: ${this.message}`;
      case "parse_app":
        return `failed to parse config.toml: ${this.message}`;
      case "parse_include":
        return `failed to parse include file ${this.path}: ${this.message}`;
      case "conf_d":
        return `failed to parse conf.d file ${this.path}: ${this.message}`;
      case "catalog":
        return `failed to parse model catalog: ${this.message}`;
      case "provider_registry":
        return `failed to parse provider registry: ${this.message}`;
      case "validation":
        return `validation error: ${this.message}`;
    }
  }
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base: TomlTable, overlay: TomlTable): void {
  for (const key of Object.keys(overlay).sort(compareByCodePoint)) {
    const overlayVal = overlay[key];
    const baseVal = base[key];
    if (isTable(baseVal) && isTable(overlayVal)) {
      deepMerge(baseVal, overlayVal);
    } else {
      base[key] = overlayVal;
    }
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function readFileOrThrow(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError("read_file", (e as Error).message, path);
  }
}

function loadDotenv(
  configDir: string,
  target: Record<string, string | undefined>,
  onWarn: ConfigWarn,
): void {
  const path = rustJoin(configDir, ".env");
  if (!exists(path)) return;

  try {
    const applied = applyDotenv(path, target);
    if (applied.length > 0) {
      console.info(`shore: loaded ${applied.length} variables from ${path}`);
    }
  } catch (e) {
    onWarn("Failed to load .env file", [
      ["path", path],
      ["error", e instanceof Error ? e.message : String(e)],
    ]);
  }
}

function parseToml(content: string, kind: ConfigErrorKind, path?: string): TomlTable {
  try {
    return Bun.TOML.parse(content) as TomlTable;
  } catch (e) {
    throw new ConfigError(kind, (e as Error).message, path);
  }
}

function loadConfD(dir: string, table: TomlTable): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ConfigError("read_file", (e as Error).message, dir);
  }

  const paths = entries
    .filter((name) => hasTomlExtension(name))
    .map((name) => rustJoin(dir, name))
    .sort(compareByCodePoint);

  for (const path of paths) {
    const content = readFileOrThrow(path);
    deepMerge(table, parseToml(content, "conf_d", path));
  }
}

function hasTomlExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return name.slice(dot + 1) === "toml";
}

export function loadRawConfigTable(
  configPath: string | undefined,
  options: {
    env?: Env;
    homeLookup?: HomeLookup;
    createDefault?: (configDir: string) => void;
    onWarn?: ConfigWarn;
    envTarget?: Record<string, string | undefined>;
  } = {},
): RawConfigTable {
  const dirs = resolveShoreDirs(options.env, options.homeLookup);

  const configDirectory = configPath === undefined ? dirs.config : parentOf(configPath);
  if (configPath !== undefined) dirs.config = configDirectory;

  const configFile = configPath ?? rustJoin(configDirectory, "config.toml");

  loadDotenv(configDirectory, options.envTarget ?? process.env, options.onWarn ?? consoleConfigWarn);

  let table: TomlTable;
  if (exists(configFile)) {
    table = parseToml(readFileOrThrow(configFile), "parse_app");
  } else {
    options.createDefault?.(configDirectory);
    table = {};
  }

  const includes = table.include;
  delete table.include;
  if (Array.isArray(includes)) {
    for (const item of includes) {
      if (typeof item !== "string") continue;
      const includePath = rustJoin(configDirectory, item);
      if (!exists(includePath)) continue;
      deepMerge(table, parseToml(readFileOrThrow(includePath), "parse_include", includePath));
    }
  }

  loadConfD(rustJoin(configDirectory, "conf.d"), table);

  return { table, dirs };
}

export function parentOf(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end -= 1;
  const trimmed = path.slice(0, end);

  if (trimmed === "/") return ".";

  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return "";
  if (slash === 0) return "/";
  return trimmed.slice(0, slash);
}

export function loadCharacterConfigTable(
  global: RawConfigTable,
  characterName: string,
): TomlTable | undefined {
  const path = rustJoin(global.dirs.config, "characters", characterName, "config.toml");
  if (!exists(path)) return undefined;

  const overlay = parseToml(readFileOrThrow(path), "parse_include", path);
  const merged = structuredClone(global.table);
  deepMerge(merged, overlay);
  return merged;
}

export const DEFAULT_CONFIG_TOML = renderStarterConfig();

export function createDefaultConfig(
  configDirectory: string,
  onWarn: ConfigWarn = consoleConfigWarn,
): string | undefined {
  try {
    mkdirSync(configDirectory, { recursive: true });
  } catch (e) {
    onWarn("Could not create config directory", [["error", String(e)]]);
    return undefined;
  }

  const path = rustJoin(configDirectory, "config.toml");
  try {
    writeFileSync(path, DEFAULT_CONFIG_TOML);
  } catch (e) {
    onWarn("Could not write default config.toml", [["error", String(e)]]);
    return undefined;
  }
  return path;
}

export type ConfigWarn = (
  message: string,
  fields: readonly (readonly [string, string])[],
) => void;

export const consoleConfigWarn: ConfigWarn = (message, fields) => {
  const suffix = fields.map(([key, value]) => ` ${key}=${value}`).join("");
  console.warn(`shore: ${message}${suffix}`);
};

export interface LoadedConfig {
  app: AppConfig;
  models: ModelCatalog;
  providers: ProviderRegistry;
  dirs: ShoreDirs;
  rawTable: TomlTable | undefined;
}

function sectionTable(value: unknown): TomlTable | undefined {
  return isTable(value) ? value : undefined;
}

export function parseConfigTable(
  table: TomlTable,
  dirs: ShoreDirs,
  onWarn: ConfigWarn = consoleConfigWarn,
): LoadedConfig {
  const rawTable = structuredClone(table);

  const remainder = { ...table };
  const chatSection = sectionTable(remainder.chat);
  const embeddingSection = sectionTable(remainder.embedding);
  const imageGenerationSection = sectionTable(remainder.image_generation);
  const providersSection = sectionTable(remainder.providers);
  delete remainder.chat;
  delete remainder.embedding;
  delete remainder.image_generation;
  delete remainder.providers;

  const parsed = parseAppConfig(remainder);
  if ("err" in parsed) throw new ConfigError("parse_app", parsed.err);
  const app = parsed.ok;

  normalizeDeprecatedAliases(app.defaults);

  let providers: ProviderRegistry;
  try {
    providers = ProviderRegistry.fromSection(providersSection);
  } catch (e) {
    if (!(e instanceof ProviderRegistryError)) throw e;
    throw new ConfigError("provider_registry", e.message);
  }

  let models: ModelCatalog;
  try {
    models = catalogFromSections(
      chatSection,
      embeddingSection,
      imageGenerationSection,
      providers,
    );
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
    throw new ConfigError("catalog", e.message);
  }

  validateConfig(app, models, providers, onWarn);

  return { app, models, providers, dirs, rawTable };
}

export function loadConfig(
  configPath: string | undefined,
  options: {
    env?: Env;
    homeLookup?: HomeLookup;
    createDefault?: (configDir: string) => void;
    onWarn?: ConfigWarn;
  } = {},
): LoadedConfig {
  const raw = loadRawConfigTable(configPath, options);
  return parseConfigTable(raw.table, raw.dirs, options.onWarn);
}

export function loadCharacterConfig(
  global: LoadedConfig,
  characterName: string,
  onWarn: ConfigWarn = consoleConfigWarn,
): LoadedConfig | undefined {
  const path = rustJoin(global.dirs.config, "characters", characterName, "config.toml");
  if (!exists(path)) return undefined;

  const overlay = parseToml(readFileOrThrow(path), "parse_include", path);
  const merged = structuredClone(global.rawTable ?? {});
  deepMerge(merged, overlay);
  return parseConfigTable(merged, global.dirs, onWarn);
}

function validationError(message: string): ConfigError {
  return new ConfigError("validation", message);
}

function validateConfig(
  app: AppConfig,
  catalog: ModelCatalog,
  providers: ProviderRegistry,
  onWarn: ConfigWarn = consoleConfigWarn,
): void {
  warnOnUnresolvableModelRef(catalog, providers, "defaults.model", app.defaults.model, onWarn);
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "defaults.background.model",
    app.defaults.background.model,
    onWarn,
  );
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "defaults.background.heartbeat",
    app.defaults.background.heartbeat,
    onWarn,
  );
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "defaults.background.compaction",
    app.defaults.background.compaction,
    onWarn,
  );
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "defaults.subagent_model",
    app.defaults.subagent_model,
    onWarn,
  );

  for (const [name, sub] of app.subagents) {
    if (app.tools.enabled_subagents.includes(name)) {
      const resolved = sub.model ?? app.defaults.subagent_model ?? app.defaults.model;
      if (resolved === undefined) {
        throw validationError(
          `subagents.${name} is enabled but resolves to no model; set ` +
            `subagents.${name}.model, defaults.subagent_model, or defaults.model`,
        );
      }
      if (!modelRefResolves(catalog, providers, resolved)) {
        throw validationError(
          `subagents.${name} resolves to model "${resolved}", which is not ` +
            "in the static catalog and is not a `provider:model_id` ref to " +
            `an enabled provider; ask_${name} would fail on first use`,
        );
      }
    } else {
      warnOnUnresolvableModelRef(
        catalog,
        providers,
        `subagents.${name}.model`,
        sub.model,
        onWarn,
      );
    }
  }

  validateMcpServers(app, onWarn);
  validateDefaultEmbedding(providers, app.defaults.embedding, onWarn);
  validateDefaultImageGeneration(providers, app.defaults.image_generation, onWarn);
  validateUsageConfig(app.usage);

  const compaction = validateCompaction(app.memory.compaction);
  if (compaction !== undefined) throw validationError(compaction);
}

function validateMcpServers(app: AppConfig, onWarn: ConfigWarn): void {
  for (const [name, server] of app.mcp) {
    const hasCommand = server.command !== undefined;
    const hasUrl = server.url !== undefined;
    if (hasCommand && hasUrl) {
      throw validationError(
        `mcp.${name} sets both \`command\` and \`url\`; set exactly one transport`,
      );
    }
    if (!hasCommand && !hasUrl) {
      throw validationError(
        `mcp.${name} sets neither \`command\` nor \`url\`; set exactly one transport`,
      );
    }
    if (hasCommand && server.headers.size > 0) {
      throw validationError(
        `mcp.${name} sets \`headers\` on a \`command\` server; headers are HTTP-only`,
      );
    }
  }

  const referenced = [
    ...app.tools.enabled_tools,
    ...[...app.subagents.values()].flatMap((s) => s.tools),
  ];
  for (const pattern of referenced) {
    if (!pattern.startsWith("mcp__")) continue;
    const server = pattern.slice("mcp__".length).split("__")[0] ?? "";
    if (server !== "" && server !== "*" && !app.mcp.has(server)) {
      onWarn(
        `tool grant references MCP server with no [mcp.${server}] definition; ` +
          "it will match no tools",
        [
          ["pattern", pattern],
          ["server", server],
        ],
      );
    }
  }
}

function validateUsageConfig(config: UsageConfig): void {
  if (config.timezone !== "local" && config.timezone !== "utc") {
    throw validationError(
      `usage.timezone must be "local" or "utc", got "${config.timezone}"`,
    );
  }

  if (config.spike_warnings.multiplier <= 1.0) {
    throw validationError("usage.spike_warnings.multiplier must be greater than 1.0");
  }
  if (config.spike_warnings.min_cost_usd < 0.0) {
    throw validationError("usage.spike_warnings.min_cost_usd must be non-negative");
  }

  const names = new Set<string>();
  for (const [idx, budget] of config.budgets.entries()) {
    if (budget.cost_usd <= 0.0) {
      throw validationError(`usage.budgets[${idx}].cost_usd must be greater than 0`);
    }
    for (const threshold of budget.warn_at) {
      if (threshold <= 0.0) {
        throw validationError(
          `usage.budgets[${idx}].warn_at values must be greater than 0`,
        );
      }
    }
    validateBudgetAnchors(idx, budget);
    validateBudgetPace(idx, budget);

    const trimmed = rustTrim(budget.name);
    const name = trimmed === "" ? `budget ${idx + 1}` : trimmed;
    if (names.has(name)) {
      throw validationError(`usage budget name "${name}" is duplicated`);
    }
    names.add(name);
  }
}

function validateBudgetAnchors(idx: number, budget: UsageBudgetConfig): void {
  if (budget.reset_hour !== undefined) {
    if (budget.reset_hour > 23) {
      throw validationError(
        `usage.budgets[${idx}].reset_hour must be 0-23, got ${budget.reset_hour}`,
      );
    }
    if (budget.period === "hour") {
      throw validationError(
        `usage.budgets[${idx}].reset_hour is not valid for period = "hour"`,
      );
    }
  }

  if (budget.reset_day_of_week !== undefined && budget.period !== "week") {
    throw validationError(
      `usage.budgets[${idx}].reset_day_of_week is only valid for period = "week"`,
    );
  }

  if (budget.reset_day_of_month !== undefined) {
    const day = budget.reset_day_of_month;
    if (day < 1 || day > 31) {
      throw validationError(
        `usage.budgets[${idx}].reset_day_of_month must be 1-31, got ${day}`,
      );
    }
    if (budget.period !== "month") {
      throw validationError(
        `usage.budgets[${idx}].reset_day_of_month is only valid for period = "month"`,
      );
    }
  }
}

function validateBudgetPace(idx: number, budget: UsageBudgetConfig): void {
  const pace = budget.pace_period;
  if (pace === undefined) {
    if (budget.pace_action !== undefined) {
      throw validationError(`usage.budgets[${idx}].pace_action requires pace_period`);
    }
    if (budget.pace_warn_at !== undefined) {
      throw validationError(`usage.budgets[${idx}].pace_warn_at requires pace_period`);
    }
    if (budget.pace_warn_action !== undefined) {
      throw validationError(`usage.budgets[${idx}].pace_warn_action requires pace_period`);
    }
    return;
  }

  if (budgetPeriodRank(pace) >= budgetPeriodRank(budget.period)) {
    throw validationError(
      `usage.budgets[${idx}].pace_period = "${pace}" must be shorter than ` +
        `period = "${budget.period}"`,
    );
  }

  for (const threshold of budget.pace_warn_at ?? []) {
    if (threshold <= 0.0) {
      throw validationError(
        `usage.budgets[${idx}].pace_warn_at values must be greater than 0`,
      );
    }
  }
}

function validateAuxProvider(
  providers: ProviderRegistry,
  field: string,
  providerKey: string,
  onWarn: ConfigWarn,
): void {
  const entry = providers.get(providerKey);
  if (entry === undefined) {
    onWarn(
      `${field} references provider "${providerKey}" not configured under ` +
        `[providers.${providerKey}]; built-in transport defaults are used for ` +
        "well-known providers, otherwise set base_url/api_key_env there",
      [
        ["field", field],
        ["provider", providerKey],
      ],
    );
    return;
  }
  if (!entry.enabled) {
    throw validationError(
      `${field} references provider "${providerKey}" which is disabled in ` +
        `[providers.${providerKey}] (enabled = false); a disabled provider yields no ` +
        `credentials, so ${field} cannot resolve. Enable the provider or change ${field}.`,
    );
  }
}

function validateDefaultEmbedding(
  providers: ProviderRegistry,
  name: string | undefined,
  onWarn: ConfigWarn,
): void {
  if (name === undefined) return;
  const split = splitOnce(name, ":");
  if (split === undefined) {
    throw validationError(
      `defaults.embedding "${name}" must be a \`provider:model_id\` identity ` +
        "(transport lives on [providers.<provider>]); Shore ships only a hosted " +
        "OpenAI-compatible embedder, so bundled local ids are not served",
    );
  }
  const [providerKey, modelId] = split;
  if (providerKey === "" || modelId === "") {
    throw validationError(
      `defaults.embedding "${name}" is not a valid \`provider:model_id\` identity`,
    );
  }
  validateAuxProvider(providers, "defaults.embedding", providerKey, onWarn);
}

function validateDefaultImageGeneration(
  providers: ProviderRegistry,
  name: string | undefined,
  onWarn: ConfigWarn,
): void {
  if (name === undefined) return;
  const split = splitOnce(name, ":");
  if (split === undefined) {
    throw validationError(
      `defaults.image_generation "${name}" must be a \`provider:model_id\` identity ` +
        "(transport lives on [providers.<provider>])",
    );
  }
  const [providerKey, modelId] = split;
  if (providerKey === "" || modelId === "") {
    throw validationError(
      `defaults.image_generation "${name}" is not a valid \`provider:model_id\` identity`,
    );
  }
  validateAuxProvider(providers, "defaults.image_generation", providerKey, onWarn);
}

function splitOnce(s: string, sep: string): [string, string] | undefined {
  const at = s.indexOf(sep);
  if (at < 0) return undefined;
  return [s.slice(0, at), s.slice(at + sep.length)];
}

function catalogHas(catalog: ModelCatalog, name: string): boolean {
  try {
    findModel(catalog, name);
    return true;
  } catch (e) {
    if (e instanceof CatalogError) return false;
    throw e;
  }
}

function modelRefResolves(
  catalog: ModelCatalog,
  providers: ProviderRegistry,
  name: string,
): boolean {
  if (catalogHas(catalog, name)) return true;
  const split = splitOnce(name, ":");
  if (split === undefined) return false;
  const [providerKey, modelId] = split;
  if (providerKey === "" || modelId === "") return false;
  return providers.get(providerKey)?.enabled ?? false;
}

function warnOnUnresolvableModelRef(
  catalog: ModelCatalog,
  providers: ProviderRegistry,
  field: string,
  name: string | undefined,
  onWarn: ConfigWarn,
): void {
  if (name === undefined) return;
  if (catalogHas(catalog, name)) return;

  const split = splitOnce(name, ":");
  if (split !== undefined) {
    const [providerKey, modelId] = split;
    if (providerKey !== "" && modelId !== "") {
      const entry = providers.get(providerKey);
      if (entry?.enabled === true) return;
      if (entry !== undefined) {
        onWarn(
          "configured default model references a disabled provider; " +
            "a disabled provider is unreferenceable, but per-character " +
            "preferences can override at runtime",
          [
            ["field", field],
            ["name", name],
            ["provider", providerKey],
          ],
        );
        return;
      }
      onWarn(
        `configured default model references provider "${providerKey}" which ` +
          `is not configured under [providers.${providerKey}]`,
        [
          ["field", field],
          ["name", name],
          ["provider", providerKey],
        ],
      );
      return;
    }
  }

  onWarn(
    `configured default model "${name}" was not found in the static ` +
      "catalog and is not in provider:model_id form; the daemon will " +
      "attempt runtime resolution and per-character preferences can " +
      "override this without editing config",
    [
      ["field", field],
      ["name", name],
    ],
  );
}
