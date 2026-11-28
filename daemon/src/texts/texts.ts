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

export function textSpec(name: string): TextSpec {
  const spec = TEXT_SPECS.get(name);
  if (spec === undefined) throw new Error(`Shore has no text named "${name}"`);
  return spec;
}

export function readTextFile(name: string, path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`text "${name}" could not be read at ${path}: ${(error as Error).message}`, { cause: error });
  }
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

export class Texts {
  readonly #wording = new Map<string, string | undefined>();
  readonly #files = new Map<string, string>();

  constructor(settings: TextSettings = {}, configDir = "") {
    for (const [name, setting] of Object.entries(settings)) {
      if (setting === undefined) continue;
      textSpec(name);
      if (setting === false) {
        this.#wording.set(name, undefined);
        continue;
      }
      const path = resolve(configDir, setting);
      this.#files.set(name, path);
      this.#wording.set(name, readTextFile(name, path));
    }
  }

  static of(source: TextsSource): Texts {
    return new Texts(source.app.texts, source.dirs.config);
  }

  whose(name: string): Whose {
    textSpec(name);
    if (this.#files.has(name)) return "yours";
    return this.#wording.has(name) ? "off" : "shore";
  }

  file(name: string): string | undefined {
    return this.#files.get(name);
  }

  wording(name: string): string | undefined {
    const spec = textSpec(name);
    return this.#wording.has(name) ? this.#wording.get(name) : spec.shipped;
  }

  render(name: string, values: TextValues = {}): string | undefined {
    const wording = this.wording(name);
    if (wording === undefined) return undefined;
    const vars = new Map<string, string>();
    for (const [key, value] of Object.entries(values)) vars.set(key, value ?? "");
    const rendered = renderTemplate(wording, vars);
    return rendered.trim() === "" ? undefined : rendered;
  }

  always(name: string, values: TextValues = {}): string {
    const rendered = this.render(name, values);
    if (rendered === undefined) throw new Error(`text "${name}" came out empty, and Shore can't leave it out`);
    return rendered;
  }
}

let resolveCharacterTexts: (character: string) => Texts = () => new Texts();

export function useCharacterTexts(lookUp: (character: string) => Texts): void {
  resolveCharacterTexts = lookUp;
}

export function characterTexts(character: string): Texts {
  try {
    return resolveCharacterTexts(character);
  } catch {
    return new Texts();
  }
}
