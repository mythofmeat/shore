export type BridgeInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "command"; readonly name: string; readonly args: Record<string, unknown> }
  | { readonly kind: "regen" }
  | { readonly kind: "cancel" }
  | { readonly kind: "bind"; readonly character: string | undefined }
  | { readonly kind: "unbind" }
  | { readonly kind: "view"; readonly key: string | undefined; readonly value: boolean | undefined }
  | { readonly kind: "reply"; readonly text: string };

type Resolver = (args: string) => BridgeInput;

const command = (name: string, args: Record<string, unknown> = {}): BridgeInput => ({
  kind: "command",
  name,
  args,
});

const reply = (text: string): BridgeInput => ({ kind: "reply", text });

export function parseInput(raw: string): BridgeInput {
  const text = raw.trim();
  if (!text.startsWith("!")) return { kind: "text", text: raw };

  const body = text.slice(1);
  const split = body.search(/\s/);
  const name = (split === -1 ? body : body.slice(0, split)).toLowerCase();
  const args = split === -1 ? "" : body.slice(split).trim();

  const resolver = BANGS[name];
  if (resolver !== undefined) return resolver(args);
  if (args === "") return command(name);
  return reply(
    `\`!${name}\` takes no arguments through the bridge. ` +
      `Send them as JSON with \`!raw ${name} {"key": "value"}\`, or see \`!help\`.`,
  );
}

const BANGS: Record<string, Resolver> = {
  help: () => reply(HELP),

  bind: (args) => ({ kind: "bind", character: args === "" ? undefined : args }),
  unbind: () => ({ kind: "unbind" }),

  view: (args) => {
    const [key, value] = args.split(/\s+/).filter((w) => w !== "");
    return { kind: "view", key, value: parseToggle(value) };
  },

  regen: () => ({ kind: "regen" }),
  cancel: () => ({ kind: "cancel" }),

  status: () => command("status"),
  usage: () => command("usage"),
  tools: () => command("tools"),

  character: (args) => (args === "" ? command("list_characters") : command("switch_character", { name: args })),

  model: (args) => {
    if (args === "") return command("list_models", { include_hidden: false });
    if (args === "all") return command("list_models", { include_hidden: true });
    if (args === "reset" || args === "default") return command("reset_model");
    return command("switch_model", { name: args });
  },

  setting: (args) => {
    const words = args.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) return command("model_settings");
    const [key, ...rest] = words;
    if (rest.length === 0) return reply("Usage: `!setting <key> <value>`, or `!setting <key> reset`.");
    return command("set_model_setting", { key, value: parseSettingValue(rest.join(" ")) });
  },

  memory: (args) =>
    args === "" ? reply("Usage: `!memory <query>`.") : command("memory", { query: args }),

  log: (args) => {
    const turns = Number(args);
    return command("log", Number.isInteger(turns) && turns > 0 ? { turns } : {});
  },

  compact: (args) => {
    const words = args.split(/\s+/).filter((w) => w !== "");
    const out: Record<string, unknown> = {};
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i] as string;
      if (word === "dry" || word === "dry_run") out.dry_run = true;
      else if (word === "keep") {
        const keep = Number(words[i + 1]);
        if (!Number.isInteger(keep)) return reply("Usage: `!compact [dry] [keep <n>]`.");
        out.keep_turns = keep;
        i += 1;
      } else return reply("Usage: `!compact [dry] [keep <n>]`.");
    }
    return command("compact", out);
  },

  delete: (args) => {
    const refs = args.split(/\s+/).filter((w) => w !== "");
    return refs.length === 0 ? reply("Usage: `!delete <ref> [ref ...]`.") : command("delete", { refs });
  },

  edit: (args) => {
    const split = args.search(/\s/);
    if (split === -1) return reply("Usage: `!edit <ref> <new content>`.");
    return command("edit", { ref: args.slice(0, split), content: args.slice(split).trim() });
  },

  alt: (args) => {
    if (args === "" || args === "list") return command("list_alternatives");
    const position = Number(args);
    if (Number.isInteger(position) && position > 0) return command("alt", { position });
    if (["next", "prev", "previous", "first", "last"].includes(args)) {
      return command("alt", { direction: args });
    }
    return reply("Usage: `!alt [list|next|prev|first|last|<position>]`.");
  },

  sys: (args) => (args === "" ? reply("Usage: `!sys <text>`.") : command("inject_system", { text: args })),

  raw: (args) => {
    const split = args.search(/\s/);
    if (split === -1) return args === "" ? reply("Usage: `!raw <command> [json]`.") : command(args);
    const name = args.slice(0, split);
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.slice(split).trim());
    } catch (e) {
      return reply(`\`!raw\` needs valid JSON arguments: ${String(e)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return reply("`!raw` arguments must be a JSON object.");
    }
    return command(name, parsed as Record<string, unknown>);
  },
};

export function parseToggle(word: string | undefined): boolean | undefined {
  if (word === undefined) return undefined;
  if (["on", "true", "yes", "1"].includes(word.toLowerCase())) return true;
  if (["off", "false", "no", "0"].includes(word.toLowerCase())) return false;
  return undefined;
}

export function parseSettingValue(raw: string): unknown {
  if (raw === "reset" || raw === "default" || raw === "none" || raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const number = Number(raw);
  return raw !== "" && Number.isFinite(number) ? number : raw;
}

export const HELP = [
  "**Shore bridge commands**",
  "",
  "- `!bind [character]` — bind this room to a character (no argument lists them)",
  "- `!unbind` — release this room",
  "- `!view [thinking|tools|usage] [on|off]` — what this room shows alongside replies",
  "- `!regen` / `!cancel` — redo or stop the current reply",
  "- `!status`, `!usage`, `!tools`, `!log [n]`",
  "- `!character [name]`, `!model [name|all|reset]`, `!setting <key> <value>`",
  "- `!memory <query>`, `!compact [dry] [keep <n>]`, `!sys <text>`",
  "- `!delete <ref>`, `!edit <ref> <text>`, `!alt [list|next|prev|<n>]`",
  "- `!raw <command> {json}` — send any daemon command directly",
  "",
  "React with 🔁 to regenerate, 🗑 to delete, ◀ ▶ to walk alternates.",
].join("\n");
