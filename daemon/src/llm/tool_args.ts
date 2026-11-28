export interface ParsedToolArgs {
  input: unknown;
  input_error?: string;
  input_length?: number;
}

export function parseToolArgs(argsJson: string): ParsedToolArgs {
  const trimmed = argsJson.trim();
  if (trimmed === "") return { input: {} };
  try {
    return { input: JSON.parse(trimmed) };
  } catch (e) {
    return { input: {}, input_error: e instanceof Error ? e.message : String(e), input_length: trimmed.length };
  }
}
