export type ThinkingDisplay = "summarized" | "omitted";

const NO_THINKING_SURFACE: ReadonlySet<string> = new Set([
  "compaction",
  "keepalive",
  "memory_agent",
]);

export function thinkingDisplayForCallType(callType: string | undefined): ThinkingDisplay {
  if (callType === undefined) return "summarized";
  return NO_THINKING_SURFACE.has(callType) ? "omitted" : "summarized";
}
