const CARRIER = Symbol("shore.tool_media");

export const MAX_INLINE_TOOL_IMAGES = 2;

export interface ToolMediaItem {
  mime_type: string;
  data: string;
  label: string;
}

export interface ToolResultPayload {
  value: unknown;
  media: ToolMediaItem[];
  extra: string[];
}

export function carryToolMedia(payload: ToolResultPayload): unknown {
  if (payload.media.length === 0 && payload.extra.length === 0) return payload.value;
  return { [CARRIER]: payload };
}

export function toolMediaOf(value: unknown): ToolResultPayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const carried = (value as Record<symbol, unknown>)[CARRIER];
  if (carried === undefined) return undefined;
  return carried as ToolResultPayload;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => Object.hasOwn(right, k) && deepEqual(left[k], right[k]));
}

export function payloadText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

export function renderPayload(payload: ToolResultPayload): string {
  const head = payloadText(payload.value);
  const parts = head === "" ? [] : [head];
  parts.push(...payload.extra);
  for (const item of payload.media) parts.push(`[${item.label} returned, not included here]`);
  return parts.join("\n");
}

export function renderToolValue(value: unknown): string {
  const payload = toolMediaOf(value);
  return payload === undefined ? payloadText(value) : renderPayload(payload);
}

export function base64Bytes(data: string): number {
  const normalized = data.replace(/\s+/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}
