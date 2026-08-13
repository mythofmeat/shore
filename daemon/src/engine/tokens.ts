export const BYTES_PER_TOKEN = 3;

export const CONTEXT_SAFETY_FRACTION = 0.1;

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function estimateTokens(text: string): number {
  return Math.ceil(byteLength(text) / BYTES_PER_TOKEN);
}

export function withSafetyMargin(tokens: number): number {
  return Math.max(0, Math.floor(tokens * (1 - CONTEXT_SAFETY_FRACTION)));
}
