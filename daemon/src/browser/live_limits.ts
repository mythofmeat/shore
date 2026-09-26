export const MAX_LIVE_TEXT = 512 * 1024;
export const MAX_LIVE_BLOCKS = 64;
export const MAX_LIVE_BLOCK_CHARS = 512 * 1024;
export const MAX_ACTIVITY_CHARS = 64 * 1024;
export const MAX_LIVE_MEDIA_CHARS = 16 * 1024 * 1024;

export function recentText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const start = text.length - limit;
  const code = text.charCodeAt(start);
  return text.slice(start + (code >= 0xdc00 && code <= 0xdfff ? 1 : 0));
}

export function recentItems<T>(items: readonly T[], maxItems: number, maxChars: number, size: (item: T) => number): { items: T[]; limited: boolean } {
  const kept: T[] = [];
  let chars = 0;
  for (let index = items.length - 1; index >= 0 && kept.length < maxItems; index--) {
    const item = items[index];
    if (item === undefined) continue;
    const length = size(item);
    if (length + chars > maxChars) continue;
    kept.push(item);
    chars += length;
  }
  return { items: kept.reverse(), limited: kept.length !== items.length };
}

export function inspectionPreview(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= MAX_ACTIVITY_CHARS) return value;
  const fields = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const scope = Object.fromEntries(["type", "rid", "subagent", "task_id"].flatMap((key) => typeof fields[key] === "string" ? [[key, fields[key].slice(0, 256)]] : []));
  return { ...scope, previewLimited: true, preview: recentText(text, MAX_ACTIVITY_CHARS) };
}
