import { join } from "node:path";
import type { ShoreRuntime } from "../../src/runtime.ts";
import { ZERO_USAGE } from "../../src/call_store.ts";
import { appendSubagentTrace } from "../../src/tools/subagent_trace.ts";
import { redactHeaders } from "../../src/llm/redact.ts";
import { HeartbeatLog } from "../../src/autonomy/heartbeat_log.ts";
import { HEARTBEAT_LOG_FILENAME } from "../../src/autonomy/service.ts";

export async function seedDiagnosticFixture(runtime: ShoreRuntime, character: string): Promise<void> {
  const store = runtime.callStore;
  if (store === undefined) throw new Error("Diagnostic fixture requires call capture");
  const ts = new Date("2026-09-01T12:00:00Z");
  for (const [index, text] of ["First captured request", "<img src=x onerror=alert('unsafe')>"].entries()) {
    const callId = `diagnostic-call-${String(index)}`;
    const body = JSON.stringify({ model: "fixture", input: text, api_key: "[redacted]", future_field: { inspectable: true } });
    store.recordCall({ call_id: callId, ts, character, call_type: "diagnostic_fixture", model: "fixture", provider: "fixture", usage: { ...ZERO_USAGE, input_tokens: 10 + index, output_tokens: 2 }, duration_ms: index + 1, finish_reason: "end_turn", request_body: body, response_body: JSON.stringify({ text: `Captured response ${String(index)}` }) });
    store.recordHttpCall({ call_id: callId, seq: 0, ts, character, call_type: "diagnostic_fixture", rid: `capture-${String(index)}`, method: "POST", url: "https://fixture.invalid/v1/messages", status: 200, status_text: "OK", duration_ms: 1, request_headers: redactHeaders([["Authorization", "private-fixture-key"], ["x-request-id", callId]]), request_body: new TextEncoder().encode(body), response_headers: redactHeaders([["Set-Cookie", "private-session-cookie"], ["content-type", "application/json"]]), response_body: new TextEncoder().encode('{"text":"Wire response"}') });
  }
  for (const source of ["heartbeat", "memory_recall"] as const) store.recordTranscript({ ts, source, character, call_type: source, iteration: 1, model: "fixture", provider: "fixture", usage: ZERO_USAGE, entry_json: JSON.stringify(source === "heartbeat" ? { reasoning: ["Checked the clock"], text: "Heartbeat fixture transcript", tool_calls: [{ name: "read", input: { path: "SOUL.md" }, output: "Stored tool output", is_error: false }] } : { query: "Remember the stored fixture", memories: [{ text: "A retained memory", score: 0.9 }], future_detail: "Inspectable recall data" }) });
  const characterDir = join(runtime.registry.globalConfig().dirs.data, character);
  const log = await HeartbeatLog.load(join(characterDir, HEARTBEAT_LOG_FILENAME));
  log.push("wake", "Fixture heartbeat wake", ts.toISOString());
  await log.flushIfDirty();
  await appendSubagentTrace(characterDir, { ts: ts.toISOString(), subagent: "worker", parent_tool_use_id: "parent-fixture", rid: "parent-request", model: "fixture", messages: [{ msg_id: "fixture-message", role: "assistant", content: "Stored worker message", content_blocks: [{ type: "text", text: "Stored worker message" }], images: [], timestamp: ts.toISOString() }], result: "Stored worker result" });
  await appendSubagentTrace(characterDir, { ts: ts.toISOString(), subagent: "expired-worker", parent_tool_use_id: "parent-expired", model: "fixture", messages: [], messages_expired: true, result: "Retained result after expiry" });
}
