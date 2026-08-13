export interface ParsedToolArgs {
  input: unknown;
  input_error?: string;
}

export function parseToolArgs(argsJson: string): ParsedToolArgs {
  const trimmed = argsJson.trim();
  if (trimmed === "") return { input: {} };
  try {
    return { input: JSON.parse(trimmed) };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      input: {},
      input_error: `the arguments were not valid JSON (${why}); ${String(trimmed.length)} characters arrived`,
    };
  }
}
