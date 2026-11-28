import { readState, writeState } from "../storage/store.ts";
import { TEXTS } from "./registry.ts";

const SEEN = "texts_seen.json";

export type SeenWordings = Readonly<Record<string, string>>;

export function seenWordings(dataDir: string): SeenWordings | undefined {
  const raw = readState(dataDir, SEEN);
  return raw === undefined ? undefined : JSON.parse(raw) as SeenWordings;
}

export function markTextsSeen(dataDir: string): void {
  writeState(dataDir, SEEN, JSON.stringify(Object.fromEntries(TEXTS.map((spec) => [spec.name, spec.shipped]))));
}

export function noteFirstTexts(dataDir: string): void {
  if (seenWordings(dataDir) === undefined) markTextsSeen(dataDir);
}
