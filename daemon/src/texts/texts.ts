import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { TEXT_SPECS, type TextSpec } from "./registry.ts";
import { renderTemplate } from "./template.ts";

export type TextSetting = string | false;

export type TextSettings = Readonly<Record<string, TextSetting | undefined>>;

export type TextValues = Readonly<Record<string, string | undefined>>;

export type Whose = "shore" | "yours" | "off";

export interface TextsSource {
  app: { texts: TextSettings };
  dirs: { config: string };
}

function specOf(name: string): TextSpec {
  const spec = TEXT_SPECS.get(name);
  if (spec === undefined) throw new Error(`Shore has no text named "${name}"`);
  return spec;
}

function withoutOneNewline(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

export class Texts {
  readonly #settings: TextSettings;
  readonly #configDir: string;
  readonly #read = new Map<string, string>();

  constructor(settings: TextSettings = {}, configDir = "") {
    this.#settings = settings;
    this.#configDir = configDir;
  }

  static of(source: TextsSource): Texts {
    return new Texts(source.app.texts, source.dirs.config);
  }

  whose(name: string): Whose {
    const setting = this.#settings[specOf(name).name];
    return setting === undefined ? "shore" : setting === false ? "off" : "yours";
  }

  file(name: string): string | undefined {
    const setting = this.#settings[specOf(name).name];
    return typeof setting === "string" ? resolve(this.#configDir, setting) : undefined;
  }

  wording(name: string): string | undefined {
    const spec = specOf(name);
    const setting = this.#settings[name];
    if (setting === undefined) return spec.shipped;
    if (setting === false) return undefined;
    const kept = this.#read.get(name);
    if (kept !== undefined) return kept;
    const path = resolve(this.#configDir, setting);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`text "${name}" could not be read at ${path}: ${(error as Error).message}`, { cause: error });
    }
    const wording = withoutOneNewline(raw);
    this.#read.set(name, wording);
    return wording;
  }

  render(name: string, values: TextValues = {}): string | undefined {
    const wording = this.wording(name);
    if (wording === undefined) return undefined;
    const vars = new Map<string, string>();
    for (const [key, value] of Object.entries(values)) vars.set(key, value ?? "");
    return renderTemplate(wording, vars);
  }

  always(name: string, values: TextValues = {}): string {
    const rendered = this.render(name, values);
    if (rendered === undefined) throw new Error(`text "${name}" can't be switched off`);
    return rendered;
  }
}
