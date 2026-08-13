const TOKEN_CEILING_REASONS: ReadonlySet<string> = new Set(["max_tokens", "length"]);

export function hitTokenCeiling(finishReason: string): boolean {
  return TOKEN_CEILING_REASONS.has(finishReason);
}
