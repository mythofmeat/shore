export const BYTES_PER_TOKEN = 4;

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function estimateTokens(text: string): number {
  return Math.ceil(byteLength(text) / BYTES_PER_TOKEN);
}
