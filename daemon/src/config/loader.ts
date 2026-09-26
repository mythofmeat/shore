import { validateConfigSource } from "./schema.ts";
import { shoreLog } from "../log.ts";
import { hardcodedProviderBaseUrl } from "../llm/request.ts";

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { compareByCodePoint } from "../util/sort.ts";
import { webBinding } from "../web/policy.ts";
import {
  budgetPeriodRank,
  parseAppConfig,
  toolGrants,
  validateCompaction,
  validateHeartbeat,
  validateAppConfigLayer,
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
import { prepareDotenv } from "./dotenv.ts";
import { rustTrim } from "./duration.ts";
import { catalogFromSections, findModel, readModelConfigFields, CatalogError, type ModelCatalog } from "./models.ts";
import { ProviderRegistry, ProviderRegistryError } from "./providers.ts";
import { renderStarterConfig } from "./starter.ts";
import { formatConfigPath, normalizeConfigSource } from "./surface.ts";

export type TomlTable = Record<string, unknown>;

export interface RawConfigTable {
  table: TomlTable;
  dirs: ShoreDirs;
  files: string[];
  adoptEnvironment?: () => void;
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
): (() => void) | undefined {
  const path = rustJoin(configDir, ".env");
  try {
    const candidate = prepareDotenv(path, target, true);
    return () => {
      candidate.adopt();
      if (candidate.keys.length > 0) shoreLog.info(`shore: loaded ${candidate.keys.length} variables from ${path}`);
    };
  } catch (e) {
    onWarn("Failed to load .env file", [
      ["path", path],
      ["error", e instanceof Error ? e.message : String(e)],
    ]);
    return undefined;
  }
}

function parseToml(content: string, kind: ConfigErrorKind, path?: string): TomlTable {
  try {
    return Bun.TOML.parse(content) as TomlTable;
  } catch (e) {
    throw new ConfigError(kind, (e as Error).message, path);
  }
}

function loadConfD(dir: string, table: TomlTable, files: string[], read: (content: string, kind: ConfigErrorKind, path: string) => TomlTable): void {
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
    deepMerge(table, read(content, "conf_d", path));
    files.push(path);
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
    deferEnvironment?: boolean;
  } = {},
): RawConfigTable {
  const dirs = resolveShoreDirs(options.env, options.homeLookup);

  const configDirectory = configPath === undefined ? dirs.config : parentOf(configPath);
  if (configPath !== undefined) dirs.config = configDirectory;

  const configFile = configPath ?? rustJoin(configDirectory, "config.toml");

  const adoptEnvironment = loadDotenv(configDirectory, options.envTarget ?? process.env, options.onWarn ?? consoleConfigWarn);

  let table: TomlTable;
  const files: string[] = [];
  const read = (content: string, kind: ConfigErrorKind, path: string): TomlTable => {
    const parsed = parseToml(content, kind, path);
    const includes = parsed.include;
    delete parsed.include;
    const normalized = normalizeSource(parsed, path);
    if (includes !== undefined) normalized.include = includes;
    return normalized;
  };
  if (exists(configFile)) {
    table = read(readFileOrThrow(configFile), "parse_app", configFile);
    files.push(configFile);
  } else {
    options.createDefault?.(configDirectory);
    if (exists(configFile)) {
      table = read(readFileOrThrow(configFile), "parse_app", configFile);
      files.push(configFile);
    } else table = {};
  }

  const includes = table.include;
  delete table.include;
  if (includes !== undefined && (!Array.isArray(includes) || includes.some((item) => typeof item !== "string"))) {
    throw new ConfigError("parse_app", `${configFile}: include must be a list of file paths`);
  }
  if (Array.isArray(includes)) {
    for (const item of includes) {
      if (typeof item !== "string") continue;
      const includePath = rustJoin(configDirectory, item);
      if (!exists(includePath)) continue;
      deepMerge(table, read(readFileOrThrow(includePath), "parse_include", includePath));
      files.push(includePath);
    }
  }

  loadConfD(rustJoin(configDirectory, "conf.d"), table, files, read);

  if (options.deferEnvironment !== true) adoptEnvironment?.();
  return { table, dirs, files, ...(adoptEnvironment === undefined ? {} : { adoptEnvironment }) };
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

  const overlay = normalizeSource(parseToml(readFileOrThrow(path), "parse_include", path), path);
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
  shoreLog.warn(`shore: ${message}${suffix}`);
};

export interface LoadedConfig {
  app: AppConfig;
  models: ModelCatalog;
  providers: ProviderRegistry;
  dirs: ShoreDirs;
  rawTable: TomlTable | undefined;
  files?: string[];
  adoptEnvironment?: () => void;
}

export function normalizeSource(
  input: TomlTable,
  source: string,
): TomlTable {
  try {
    validateConfigSource(input, source);
    const normalized = normalizeConfigSource(input, source);
    const valid = validateAppConfigLayer(normalized);
    if ("err" in valid) throw new Error(`${source}: ${valid.err}`);
    const table = normalized;
    if (table.providers !== undefined && !isTable(table.providers)) throw new Error(`${source}: providers must be a table`);
    ProviderRegistry.fromSection(sectionTable(table.providers));
    catalogFromSections(undefined, sectionTable(table.embedding), sectionTable(table.image_generation));
    for (const [name, entries] of Object.entries(sectionTable(table.chat) ?? {})) {
      if (!isTable(entries)) continue;
      const parsed = readModelConfigFields(entries);
      if ("err" in parsed) throw new Error(`${source}: ${formatConfigPath(["chat", name])}: ${parsed.err}`);
    }
    return normalized;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ConfigError("parse_app", message.startsWith(`${source}:`) ? message : `${source}: ${message}`, source);
  }
}

function sectionTable(value: unknown): TomlTable | undefined {
  return isTable(value) ? value : undefined;
}

export function parseConfigTable(
  table: TomlTable,
  dirs: ShoreDirs,
  onWarn: ConfigWarn = consoleConfigWarn,
  files: string[] = [],
  normalized = false,
): LoadedConfig {
  if (!normalized) table = normalizeSource(table, files[0] ?? "config");
  const rawTable = structuredClone(table);

  const remainder = { ...table };
  const chatSection = sectionTable(remainder.chat);
  const embeddingSection = sectionTable(remainder.embedding);
  const imageGenerationSection = sectionTable(remainder.image_generation);
  const providersSection = sectionTable(remainder.providers);
  const parsed = parseAppConfig(remainder);
  if ("err" in parsed) throw new ConfigError("parse_app", parsed.err);
  const app = parsed.ok;


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

  return { app, models, providers, dirs, rawTable, files };
}

export function loadConfig(
  configPath: string | undefined,
  options: {
    env?: Env;
    homeLookup?: HomeLookup;
    createDefault?: (configDir: string) => void;
    onWarn?: ConfigWarn;
    deferEnvironment?: boolean;
  } = {},
): LoadedConfig {
  const raw = loadRawConfigTable(configPath, { ...options, deferEnvironment: true });
  const config = parseConfigTable(raw.table, raw.dirs, options.onWarn, raw.files, true);
  if (options.deferEnvironment === true) {
    if (raw.adoptEnvironment !== undefined) config.adoptEnvironment = raw.adoptEnvironment;
  } else raw.adoptEnvironment?.();
  return config;
}

export function loadCharacterConfig(
  global: LoadedConfig,
  characterName: string,
  onWarn: ConfigWarn = consoleConfigWarn,
): LoadedConfig | undefined {
  const path = rustJoin(global.dirs.config, "characters", characterName, "config.toml");
  if (!exists(path)) return undefined;

  const overlay = normalizeSource(parseToml(readFileOrThrow(path), "parse_include", path), path);
  const merged = structuredClone(global.rawTable ?? {});
  deepMerge(merged, overlay);
  const loaded = parseConfigTable(merged, global.dirs, onWarn, [...(global.files ?? []), path], true);
  scopeOverlayBudgetsToCharacter(loaded.app.usage, overlay, characterName);
  return loaded;
}

function overlayDeclaresBudgets(overlay: TomlTable): boolean {
  const usage = overlay["usage"];
  return isTable(usage) && Array.isArray(usage["budgets"]);
}

function scopeOverlayBudgetsToCharacter(
  usage: UsageConfig,
  overlay: TomlTable,
  characterName: string,
): void {
  if (!overlayDeclaresBudgets(overlay)) return;
  for (const budget of usage.budgets) {
    budget.character ??= characterName;
  }
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
  warnOnUnresolvableModelRef(catalog, providers, "chat.model", app.defaults.model, onWarn);
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "heartbeat.model",
    app.defaults.background.heartbeat,
    onWarn,
  );
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "compaction.model",
    app.defaults.background.compaction,
    onWarn,
  );
  warnOnUnresolvableModelRef(
    catalog,
    providers,
    "subagents.model",
    app.defaults.subagent_model,
    onWarn,
  );

  for (const [name, sub] of app.subagents) {
    if (app.tools.enabled_subagents.includes(name)) {
      const resolved = sub.model ?? app.defaults.subagent_model ?? app.defaults.model;
      if (resolved === undefined) {
        throw validationError(
          `subagents.${name} is enabled but resolves to no model; set ` +
            `subagents.${name}.model, subagents.model, or chat.model`,
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
  if (app.daemon.web.enabled) {
    try { webBinding(app.daemon.web); }
    catch (error) { throw validationError(error instanceof Error ? error.message : String(error)); }
  }

  const compaction = validateCompaction(app.memory.compaction);
  if (compaction !== undefined) throw validationError(compaction);

  const heartbeat = validateHeartbeat(app.behavior.autonomy.heartbeat);
  if (heartbeat !== undefined) throw validationError(heartbeat);

}

export const WEB_SEARCH_REMOVED =
  "tool 'web_search' was removed and grants nothing; configure a search MCP server " +
  "such as [mcp.tavily] and grant it with tools.mcp or an mcp__<server>__* tool pattern";

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
    if (hasCommand && server.bearer_token_env !== undefined) {
      throw validationError(
        `mcp.${name} sets \`bearer_token_env\` on a \`command\` server; it is HTTP-only`,
      );
    }
    if (server.bearer_token_env !== undefined && [...server.headers.keys()].some((key) => key.toLowerCase() === "authorization")) {
      throw validationError(
        `mcp.${name} sets both \`bearer_token_env\` and an Authorization header; set one`,
      );
    }
  }

  for (const server of app.tools.enabled_mcp) {
    if (server === "" || server === "*") {
      onWarn("tools.mcp names MCP servers one at a time; an empty or `*` entry matches no tools", [["server", server]]);
    }
  }
  const referenced = [
    ...toolGrants(app.tools),
    ...[...app.subagents.values()].flatMap((s) => s.tools),
  ];
  for (const pattern of referenced) {
    if (pattern === "web_search") onWarn(WEB_SEARCH_REMOVED, [["pattern", pattern]]);
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
    if (providerKey === "openai" || hardcodedProviderBaseUrl(providerKey) !== undefined) return;
    onWarn(
      `${field} references provider "${providerKey}" not configured under ` +
        `[providers.${providerKey}] and has no built-in endpoint; set base_url ` +
        "there and api_key_env if using a custom API key environment variable",
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
      `embedding.model "${name}" must be a \`provider:model_id\` identity ` +
        "(transport lives on [providers.<provider>]); Shore ships only a hosted " +
        "OpenAI-compatible embedder, so bundled local ids are not served",
    );
  }
  const [providerKey, modelId] = split;
  if (providerKey === "" || modelId === "") {
    throw validationError(
      `embedding.model "${name}" is not a valid \`provider:model_id\` identity`,
    );
  }
  validateAuxProvider(providers, "embedding.model", providerKey, onWarn);
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
      `image.model "${name}" must be a \`provider:model_id\` identity ` +
        "(transport lives on [providers.<provider>])",
    );
  }
  const [providerKey, modelId] = split;
  if (providerKey === "" || modelId === "") {
    throw validationError(
      `image.model "${name}" is not a valid \`provider:model_id\` identity`,
    );
  }
  validateAuxProvider(providers, "image.model", providerKey, onWarn);
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

export function modelRefResolves(
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
