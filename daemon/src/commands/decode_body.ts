export interface CoalescedToolCall {
  id: string;
  name: string;
  arguments: unknown;
  arguments_unparsed?: string;
}

export interface CoalescedStream {
  stream: "sse" | "events";
  model?: string;
  content: string;
  thinking?: string;
  tool_calls?: CoalescedToolCall[];
  finish_reason?: string;
  usage?: unknown;
  timing?: unknown;
  error?: unknown;
  chunk_count: number;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function scalarText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function toolCall(id: string, name: string, argsJson: string): CoalescedToolCall {
  if (argsJson.length === 0) return { id, name, arguments: {} };
  try {
    return { id, name, arguments: JSON.parse(argsJson) as unknown };
  } catch {
    return { id, name, arguments: null, arguments_unparsed: argsJson };
  }
}

function sseFrames(body: string): Obj[] | undefined {
  if (!/^\s*(event:|data:)/m.test(body)) return undefined;
  const frames: Obj[] = [];
  let sawData = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    sawData = true;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      return undefined;
    }
    if (isObj(parsed)) frames.push(parsed);
  }
  return sawData ? frames : undefined;
}

function jsonLines(body: string): Obj[] | undefined {
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return undefined;
  const out: Obj[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
    if (!isObj(parsed) || typeof parsed["type"] !== "string") return undefined;
    out.push(parsed);
  }
  return out;
}

function looksAnthropic(frames: readonly Obj[]): boolean {
  return frames.some((f) => {
    const t = f["type"];
    return (
      t === "message_start" ||
      t === "content_block_start" ||
      t === "content_block_delta" ||
      t === "message_delta"
    );
  });
}

function coalesceAnthropic(frames: readonly Obj[]): CoalescedStream {
  const blocks = new Map<number, { kind: string; id: string; name: string; args: string }>();
  let content = "";
  let thinking = "";
  const calls: CoalescedToolCall[] = [];
  let model: string | undefined;
  let finishReason: string | undefined;
  let usage: Obj | undefined;
  let error: unknown;

  for (const frame of frames) {
    const type = frame["type"];
    if (type === "message_start" && isObj(frame["message"])) {
      const message = frame["message"];
      model = str(message["model"]) ?? model;
      if (isObj(message["usage"])) usage = { ...message["usage"] };
    } else if (type === "content_block_start" && isObj(frame["content_block"])) {
      const block = frame["content_block"];
      blocks.set(Number(frame["index"]), {
        kind: String(block["type"]),
        id: str(block["id"]) ?? "",
        name: str(block["name"]) ?? "",
        args: "",
      });
    } else if (type === "content_block_delta" && isObj(frame["delta"])) {
      const state = blocks.get(Number(frame["index"]));
      const delta = frame["delta"];
      const kind = delta["type"];
      if (kind === "text_delta") content += str(delta["text"]) ?? "";
      else if (kind === "thinking_delta") thinking += str(delta["thinking"]) ?? "";
      else if (kind === "input_json_delta" && state !== undefined) {
        state.args += str(delta["partial_json"]) ?? "";
      }
    } else if (type === "content_block_stop") {
      const state = blocks.get(Number(frame["index"]));
      if (state?.kind === "tool_use") calls.push(toolCall(state.id, state.name, state.args));
    } else if (type === "message_delta") {
      if (isObj(frame["delta"])) finishReason = str(frame["delta"]["stop_reason"]) ?? finishReason;
      if (isObj(frame["usage"])) usage = { ...usage, ...frame["usage"] };
    } else if (type === "error") {
      error = frame["error"] ?? frame;
    }
  }

  return {
    stream: "sse",
    ...(model === undefined ? {} : { model }),
    content,
    ...(thinking.length === 0 ? {} : { thinking }),
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error }),
    chunk_count: frames.length,
  };
}

function coalesceChatCompletions(frames: readonly Obj[]): CoalescedStream {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let content = "";
  let thinking = "";
  let model: string | undefined;
  let finishReason: string | undefined;
  let usage: unknown;
  let error: unknown;

  for (const frame of frames) {
    model = str(frame["model"]) ?? model;
    if (frame["usage"] !== undefined && frame["usage"] !== null) usage = frame["usage"];
    if (frame["error"] !== undefined && frame["error"] !== null) error = frame["error"];

    const choices = frame["choices"];
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) {
      if (!isObj(choice)) continue;
      finishReason = str(choice["finish_reason"]) ?? finishReason;
      const delta = isObj(choice["delta"]) ? choice["delta"] : choice["message"];
      if (!isObj(delta)) continue;

      content += str(delta["content"]) ?? "";
      thinking += str(delta["reasoning_content"]) ?? str(delta["reasoning"]) ?? "";

      const toolCalls = delta["tool_calls"];
      if (!Array.isArray(toolCalls)) continue;
      for (const [position, tc] of toolCalls.entries()) {
        if (!isObj(tc)) continue;
        const index = typeof tc["index"] === "number" ? tc["index"] : position;
        let state = calls.get(index);
        if (state === undefined) {
          state = { id: `tc_${index}`, name: "", args: "" };
          calls.set(index, state);
        }
        state.id = str(tc["id"]) ?? state.id;
        const fn = isObj(tc["function"]) ? tc["function"] : undefined;
        if (fn !== undefined) {
          state.name = str(fn["name"]) ?? state.name;
          state.args += str(fn["arguments"]) ?? "";
        }
      }
    }
  }

  const ordered = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => toolCall(s.id, s.name, s.args));

  return {
    stream: "sse",
    ...(model === undefined ? {} : { model }),
    content,
    ...(thinking.length === 0 ? {} : { thinking }),
    ...(ordered.length === 0 ? {} : { tool_calls: ordered }),
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error }),
    chunk_count: frames.length,
  };
}

function coalesceStreamEvents(events: readonly Obj[]): CoalescedStream | undefined {
  const known = new Set([
    "start",
    "text",
    "thinking",
    "thinking_signature",
    "reasoning_details",
    "reasoning_content",
    "redacted_thinking",
    "tool_use",
    "done",
    "call_complete",
    "ping",
    "error",
  ]);
  if (!events.every((e) => known.has(e["type"] as string))) return undefined;

  let content = "";
  let thinking = "";
  const calls: CoalescedToolCall[] = [];
  let model: string | undefined;
  let finishReason: string | undefined;
  let usage: unknown;
  let timing: unknown;
  let error: unknown;

  for (const event of events) {
    switch (event["type"]) {
      case "start":
        model = str(event["model"]) ?? model;
        break;
      case "text":
        content += str(event["text"]) ?? "";
        break;
      case "thinking":
        thinking += str(event["text"]) ?? "";
        break;
      case "reasoning_content":
        thinking += str(event["reasoning"]) ?? "";
        break;
      case "tool_use":
        calls.push({
          id: scalarText(event["id"]),
          name: scalarText(event["name"]),
          arguments: event["input"] ?? null,
          ...(str(event["input_error"]) === undefined
            ? {}
            : { arguments_unparsed: String(event["input_error"]) }),
        });
        break;
      case "done":
        if (content.length === 0) content = str(event["content"]) ?? "";
        finishReason = str(event["finish_reason"]) ?? finishReason;
        usage = event["usage"] ?? usage;
        timing = event["timing"] ?? timing;
        break;
      case "call_complete":
        finishReason = str(event["finish_reason"]) ?? finishReason;
        usage = event["usage"] ?? usage;
        timing = event["timing"] ?? timing;
        break;
      case "error":
        error = event["message"] ?? event;
        usage = event["usage"] ?? usage;
        timing = event["timing"] ?? timing;
        break;
      default:
        break;
    }
  }

  return {
    stream: "events",
    ...(model === undefined ? {} : { model }),
    content,
    ...(thinking.length === 0 ? {} : { thinking }),
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
    ...(usage === undefined ? {} : { usage }),
    ...(timing === undefined ? {} : { timing }),
    ...(error === undefined ? {} : { error }),
    chunk_count: events.length,
  };
}

export function decodeBody(body: string | null): unknown {
  if (body === null) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
  }

  const frames = sseFrames(body);
  if (frames !== undefined) {
    if (frames.length === 0) return body;
    return looksAnthropic(frames) ? coalesceAnthropic(frames) : coalesceChatCompletions(frames);
  }

  const events = jsonLines(body);
  if (events !== undefined) {
    const coalesced = coalesceStreamEvents(events);
    if (coalesced !== undefined) return coalesced;
  }

  return body;
}
