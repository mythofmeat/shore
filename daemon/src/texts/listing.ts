import { resolve } from "node:path";

import { CLI_TEXTS } from "../llm/providers/claude_agent_injections.ts";
import type { TextEntry } from "../protocol/TextEntry.ts";
import type { TextListing } from "../protocol/TextListing.ts";
import { TEXTS, type TextSpec } from "./registry.ts";
import type { SeenWordings } from "./seen.ts";
import { readTextFile, type TextsSource } from "./texts.ts";

function change(spec: TextSpec, seen: SeenWordings | undefined): Pick<TextEntry, "changed" | "previous"> {
  if (seen === undefined) return { changed: false, previous: null };
  const previous = seen[spec.name];
  return { changed: previous !== spec.shipped, previous: previous === undefined || previous === spec.shipped ? null : previous };
}

function entry(spec: TextSpec, source: TextsSource, seen: SeenWordings | undefined): TextEntry {
  const base = {
    name: spec.name,
    place: spec.where,
    required: spec.required,
    shipped: spec.shipped,
    values: Object.entries(spec.values).map(([name, about]) => ({ name, about })),
    changed: false,
    previous: null,
  };
  const setting = source.app.texts[spec.name];
  if (setting === undefined) return { ...base, owner: "shore", wording: spec.shipped, file: null, error: null, ...change(spec, seen) };
  if (setting === false) return { ...base, owner: "off", wording: null, file: null, error: null };
  const file = resolve(source.dirs.config, setting);
  try {
    return { ...base, owner: "yours", wording: readTextFile(spec.name, file), file, error: null };
  } catch (error) {
    return { ...base, owner: "yours", wording: null, file, error: (error as Error).message };
  }
}

export function listTexts(source: TextsSource, seen: SeenWordings | undefined): TextListing {
  return {
    texts: [
      ...TEXTS.map((spec) => entry(spec, source, seen)),
      ...CLI_TEXTS.map(({ name, place, wording }): TextEntry => ({ name, place, owner: "cli", required: false, wording, shipped: wording, file: null, error: null, values: [], changed: false, previous: null })),
    ],
  };
}
