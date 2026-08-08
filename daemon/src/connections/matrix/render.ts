type Json = Record<string, unknown>;

const RENDERERS: Record<string, (data: Json) => string | undefined> = {
  status: renderStatus,
  list_characters: renderCharacters,
  list_models: renderModels,
  model_settings: renderModelSettings,
  list_alternatives: renderAlternatives,
  alt: renderAlt,
  memory: renderMemory,
  log: renderLog,
  history_page: renderLog,
};

export function renderCommandOutput(name: string, data: unknown): string {
  const table = isJson(data) ? RENDERERS[name] : undefined;
  return table?.(data as Json) ?? renderFallback(name, data);
}

function renderFallback(name: string, data: unknown): string {
  let pretty: string;
  try {
    pretty = JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    pretty = String(data);
  }
  return `**${name}**\n\`\`\`json\n${pretty}\n\`\`\``;
}

function renderStatus(data: Json): string | undefined {
  const character = str(data, "character");
  if (character === undefined) return undefined;

  const lines = [`**${character}** — status`];
  const model = str(data, "active_model");
  if (model !== undefined) lines.push(`- model: \`${model}\``);
  const turns = num(data, "turn_count");
  if (turns !== undefined) lines.push(`- turns: ${turns}`);

  const tokens = data.tokens;
  if (isJson(tokens)) {
    const get = (key: string) => num(tokens, key) ?? 0;
    lines.push(
      `- session tokens: ${get("input")} in / ${get("output")} out ` +
        `(cache ${get("cache_read")} read / ${get("cache_write")} write)`,
    );
  }

  const autonomy = data.autonomy;
  if (isJson(autonomy)) {
    const state = str(autonomy, "state") ?? str(autonomy, "mode");
    if (state !== undefined) lines.push(`- autonomy: ${state}`);
  }
  return lines.join("\n");
}

function renderCharacters(data: Json): string | undefined {
  const characters = arr(data, "characters");
  if (characters === undefined) return undefined;

  const lines = ["**Characters**"];
  for (const entry of characters) {
    if (!isJson(entry)) return undefined;
    const name = str(entry, "name");
    if (name === undefined) return undefined;
    const description = str(entry, "description");
    lines.push(
      description === undefined || description === "" ? `- **${name}**` : `- **${name}** — ${description}`,
    );
  }
  return lines.join("\n");
}

function renderModels(data: Json): string | undefined {
  const models = arr(data, "models");
  if (models === undefined) return undefined;
  const active = str(data, "active");

  const lines = ["**Models**"];
  for (const entry of models) {
    if (!isJson(entry)) return undefined;
    const qualified = str(entry, "qualified_name") ?? str(entry, "name");
    if (qualified === undefined) return undefined;
    const short = str(entry, "name") ?? qualified;
    const marker = active === qualified || active === short ? "**●** " : "";
    let line = `- ${marker}\`${qualified}\``;
    const provider = str(entry, "provider");
    if (provider !== undefined) line += ` (${provider})`;
    if (entry.hidden === true) line += " _hidden_";
    lines.push(line);
  }

  const hidden = num(data, "hidden_count");
  if (hidden !== undefined && hidden > 0 && data.include_hidden !== true) {
    lines.push(`\n_${hidden} hidden — \`!model all\` to include._`);
  }
  return lines.join("\n");
}

function renderModelSettings(data: Json): string | undefined {
  const model = str(data, "model");
  const sampler = data.effective_sampler;
  if (model === undefined || !isJson(sampler)) return undefined;
  const scopes = isJson(data.scopes) ? data.scopes : undefined;

  const lines = [`**Sampler** — \`${model}\``];
  for (const [key, value] of Object.entries(sampler)) {
    if (value === null || value === undefined) continue;
    const scope = scopes === undefined ? undefined : str(scopes, key);
    lines.push(`- ${key}: \`${scalar(value)}\`${scope === undefined ? "" : ` _(${scope})_`}`);
  }
  if (lines.length === 1) lines.push("_all defaults_");
  return lines.join("\n");
}

function renderAlternatives(data: Json): string | undefined {
  const alternatives = arr(data, "alternatives");
  if (alternatives === undefined) return undefined;
  const count = num(data, "alt_count") ?? alternatives.length;

  const lines = [`**Alternate responses** (${count}) — switch with \`!alt <n>\` or ◀ ▶ reactions`];
  for (const entry of alternatives) {
    if (!isJson(entry)) return undefined;
    const position = num(entry, "position");
    if (position === undefined) return undefined;
    const marker = entry.active === true ? "**▶**" : "·";
    lines.push(`${marker} ${position}. ${preview(str(entry, "content") ?? "", 160)}`);
  }
  return lines.join("\n");
}

function renderAlt(data: Json): string | undefined {
  const position = num(data, "position");
  const count = num(data, "alt_count");
  const content = str(data, "content");
  if (position === undefined || count === undefined || content === undefined) return undefined;
  return `Switched to alternative ${position}/${count}:\n\n${content}`;
}

function renderMemory(data: Json): string | undefined {
  const results = arr(data, "results");
  if (results === undefined) return undefined;
  const query = str(data, "query") ?? "memory";
  if (results.length === 0) return `No memory matches for _${query}_.`;

  const lines = [`**Memory matches** — _${query}_`];
  for (const entry of results) {
    if (typeof entry === "string") {
      lines.push(`- ${preview(entry, 200)}`);
      continue;
    }
    if (!isJson(entry)) return undefined;
    const label = str(entry, "file") ?? str(entry, "path") ?? str(entry, "title");
    const body = str(entry, "snippet") ?? str(entry, "content") ?? str(entry, "text");
    if (body === undefined) return undefined;
    lines.push(label === undefined ? `- ${preview(body, 200)}` : `- **${label}** — ${preview(body, 200)}`);
  }
  return lines.join("\n");
}

const ROLE_ICONS: Record<string, string> = {
  user: "👤",
  assistant: "🤖",
  system: "⚙️",
};

function renderLog(data: Json): string | undefined {
  const messages = arr(data, "messages");
  if (messages === undefined) return undefined;
  if (messages.length === 0) return "_No messages._";

  const lines = [`**Recent messages** (${messages.length})`];
  for (const entry of messages) {
    if (!isJson(entry)) return undefined;
    const role = str(entry, "role") ?? "?";
    lines.push(`- ${ROLE_ICONS[role] ?? role} ${preview(str(entry, "content") ?? "", 160)}`);
  }
  return lines.join("\n");
}

export function preview(content: string, maxChars: number): string {
  const flat = [...content.replaceAll("\n", " ")];
  return flat.length <= maxChars ? flat.join("") : `${flat.slice(0, maxChars).join("")}…`;
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "—";
  return JSON.stringify(value) ?? String(value);
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(data: Json, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function num(data: Json, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arr(data: Json, key: string): unknown[] | undefined {
  const value = data[key];
  return Array.isArray(value) ? value : undefined;
}
