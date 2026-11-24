import { resolve } from "node:path";

import { CLI_TEXTS } from "../llm/providers/claude_agent_injections.ts";
import type { TextEntry } from "../protocol/TextEntry.ts";
import type { TextListing } from "../protocol/TextListing.ts";
import { TEXTS, type TextSpec } from "./registry.ts";
import { readTextFile, type TextsSource } from "./texts.ts";

function entry(spec: TextSpec, source: TextsSource): TextEntry {
  const base = {
    name: spec.name,
    place: spec.where,
    required: spec.required,
    shipped: spec.shipped,
    values: Object.entries(spec.values).map(([name, about]) => ({ name, about })),
  };
  if (spec.fixed) return { ...base, owner: "fixed", wording: spec.shipped, file: null, error: null };
  const setting = source.app.texts[spec.name];
  if (setting === undefined) return { ...base, owner: "shore", wording: spec.shipped, file: null, error: null };
  if (setting === false) return { ...base, owner: "off", wording: null, file: null, error: null };
  const file = resolve(source.dirs.config, setting);
  try {
    return { ...base, owner: "yours", wording: readTextFile(spec.name, file), file, error: null };
  } catch (error) {
    return { ...base, owner: "yours", wording: null, file, error: (error as Error).message };
  }
}

export function listTexts(source: TextsSource): TextListing {
  return {
    texts: [
      ...TEXTS.map((spec) => entry(spec, source)),
      ...CLI_TEXTS.map(({ name, place, wording }): TextEntry => ({ name, place, owner: "cli", required: false, wording, shipped: wording, file: null, error: null, values: [] })),
    ],
  };
}
