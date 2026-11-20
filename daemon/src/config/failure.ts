import type { ConfigPathPart, ParseFailure } from "./duration.ts";
import { formatConfigPath } from "./surface.ts";

export function within(part: ConfigPathPart, failure: ParseFailure): ParseFailure {
  return { err: failure.err, at: [part, ...(failure.at ?? [])] };
}

export function configPathText(path: readonly ConfigPathPart[]): string {
  let text = "";
  for (const part of path) {
    if (typeof part === "number") text += `[${String(part)}]`;
    else text += `${text === "" ? "" : "."}${formatConfigPath([part])}`;
  }
  return text;
}

export function placed(failure: ParseFailure, base: readonly ConfigPathPart[] = []): string {
  const path = [...base, ...(failure.at ?? [])];
  return path.length === 0 ? failure.err : `${configPathText(path)}: ${failure.err}`;
}
