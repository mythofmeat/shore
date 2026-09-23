import type { ServerMessage } from "../protocol/ServerMessage.ts";

export interface ToolActivity { id: string; label: string; text: string }
const MAX_ENTRIES = 64;
const MAX_TEXT = 16000;
export function recordToolActivity(previous: readonly ToolActivity[], message: ServerMessage): ToolActivity[] {
  const scope = "subagent" in message ? [message.subagent, message.task_id] : [];
  let item: ToolActivity;
  switch (message.type) {
    case "tool_call": item = { id: JSON.stringify(["tool", ...scope, message.tool_id]), label: `Running ${message.tool_name}`, text: "" }; break;
    case "tool_result": item = { id: JSON.stringify(["tool", ...scope, message.tool_id]), label: `${message.is_error ? "Failed" : "Completed"} ${message.tool_name}`, text: message.output }; break;
    case "phase": item = { id: "phase", label: message.phase, text: message.model ?? "" }; break;
    case "send_image": item = { id: JSON.stringify(["image", ...scope, message.path]), label: "Image received", text: message.caption ?? message.path.split(/[\\/]/).at(-1) ?? "Tool image" }; break;
    case "stream_start": case "stream_chunk": case "stream_end": {
      const kind = message.type === "stream_chunk" ? message.content_type : "text";
      const id = JSON.stringify(["stream", ...scope, kind]);
      const old = previous.find((entry) => entry.id === id)?.text ?? "";
      item = { id, label: `${message.subagent ?? "Tool"} · ${kind === "thinking" ? "reasoning" : "response"}`, text: message.type === "stream_chunk" ? old + message.text : message.type === "stream_end" ? message.content : old };
      break;
    }
    case "error": item = { id: "error", label: "Tool request error", text: message.message }; break;
    default: return [...previous];
  }
  return [...previous.filter((entry) => entry.id !== item.id), { ...item, text: item.text.slice(-MAX_TEXT) }].slice(-MAX_ENTRIES);
}
