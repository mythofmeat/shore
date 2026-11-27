export function base64Bytes(data: string): number {
  const normalized = /\s/.test(data) ? data.replace(/\s+/g, "") : data;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

const B64_ALPHABET = /^[A-Za-z0-9+/]$/;

export function base64Rejection(b64: string): string | undefined {
  const firstPad = b64.indexOf("=");
  const padIsPositioned =
    firstPad === -1 || firstPad === b64.length - 1 || firstPad === b64.length - 2;

  for (let i = 0; i < b64.length; i += 1) {
    const ch = b64[i] as string;
    if (B64_ALPHABET.test(ch)) continue;
    if (ch === "=" && padIsPositioned && i >= firstPad) {
      continue;
    }
    return `Invalid symbol ${ch.charCodeAt(0)}, offset ${i}.`;
  }

  const remainder = b64.length % 4;
  if (remainder === 1) return `Invalid input length: ${b64.length}`;
  if (remainder !== 0) return "Invalid padding";
  return undefined;
}
