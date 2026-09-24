export function base64Bytes(data: string): number {
  const normalized = /\s/.test(data) ? data.replace(/\s+/g, "") : data;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}
