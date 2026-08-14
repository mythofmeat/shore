import { afterEach, describe, expect, test } from "bun:test";

import { CallStore } from "../src/call_store.ts";
import { captureProviders } from "../src/llm/capture.ts";
import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { REDACTED } from "../src/llm/redact.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import {
  installWireCapture,
  newWireScope,
  withWireScope,
  wireScopedIteration,
  type WireExchange,
} from "../src/llm/wire_capture.ts";

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

function collector(): { sink: (e: WireExchange) => void; seen: WireExchange[] } {
  const seen: WireExchange[] = [];
  return { sink: (e) => seen.push(e), seen };
}

function textOf(body: Uint8Array | null): string {
  return body === null ? "" : new TextDecoder().decode(body);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function scope(callId = "call-1") {
  return newWireScope(callId, { character: "Rhia", call_type: "chat", rid: "r-9" });
}

describe("wire capture", () => {
  test("records the exact request bytes and every header, with the credential masked", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(`{"ok":true}`) });
    const { sink, seen } = collector();
    uninstall = installWireCapture(sink);

    const body = JSON.stringify({ model: "claude-opus-4-6", messages: [{ role: "user" }] });
    await withWireScope(scope(), async () => {
      await fetch(`http://localhost:${server.port}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": "sk-ant-super-secret",
          "anthropic-beta": "prompt-caching-2024-07-31",
          "content-type": "application/json",
        },
        body,
      });
    });
    await settle();
    server.stop(true);

    expect(seen).toHaveLength(1);
    const exchange = seen[0]!;
    expect(textOf(exchange.request_body)).toBe(body);
    expect(exchange.method).toBe("POST");
    expect(exchange.status).toBe(200);
    expect(textOf(exchange.response_body)).toBe(`{"ok":true}`);

    const headers = new Map(exchange.request_headers);
    expect(headers.get("x-api-key")).toBe(REDACTED);
    expect(headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
  });

  test("carries the call identity from the surrounding scope", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("{}") });
    const { sink, seen } = collector();
    uninstall = installWireCapture(sink);

    await withWireScope(scope("call-42"), async () => {
      await fetch(`http://localhost:${server.port}/`);
    });
    await settle();
    server.stop(true);

    expect(seen[0]).toMatchObject({
      call_id: "call-42",
      character: "Rhia",
      call_type: "chat",
      rid: "r-9",
      seq: 0,
    });
  });

  test("records each retry attempt as its own exchange", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return hits < 3 ? new Response("overloaded", { status: 529 }) : new Response("{}");
      },
    });
    const { sink, seen } = collector();
    uninstall = installWireCapture(sink);

    await withWireScope(scope(), async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await fetch(`http://localhost:${server.port}/`, { method: "POST", body: "x" });
      }
    });
    await settle();
    server.stop(true);

    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(seen.map((e) => e.status)).toEqual([529, 529, 200]);
    expect(textOf(seen[0]!.response_body)).toBe("overloaded");
  });

  test("captures a streamed body without withholding it from the caller", async () => {
    const chunks = ["event: a\ndata: {\"i\":1}\n\n", "event: b\ndata: {\"i\":2}\n\n"];
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { sink, seen } = collector();
    uninstall = installWireCapture(sink);

    const received = await withWireScope(scope(), async () => {
      const response = await fetch(`http://localhost:${server.port}/`);
      return await response.text();
    });
    await settle();
    server.stop(true);

    expect(received).toBe(chunks.join(""));
    expect(textOf(seen[0]!.response_body)).toBe(chunks.join(""));
  });

  test("passes through untouched when no call scope is active", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("mcp traffic") });
    const { sink, seen } = collector();
    uninstall = installWireCapture(sink);

    const response = await fetch(`http://localhost:${server.port}/`);
    expect(await response.text()).toBe("mcp traffic");
    await settle();
    server.stop(true);

    expect(seen).toHaveLength(0);
  });

  test("records a transport failure with no response", async () => {
    const { sink, seen } = collector();
    uninstall = installWireCapture(sink);

    await withWireScope(scope(), async () => {
      await expect(fetch("http://127.0.0.1:1/unreachable")).rejects.toThrow();
    });
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBeNull();
    expect(seen[0]!.error).not.toBeNull();
  });

  test("scopes an async generator across its whole iteration", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("{}") });
    const { sink, seen } = collector();
    uninstall = installWireCapture(sink);

    async function* stream(): AsyncIterable<number> {
      await fetch(`http://localhost:${server.port}/first`);
      yield 1;
      await fetch(`http://localhost:${server.port}/second`);
      yield 2;
    }

    const out: number[] = [];
    for await (const value of wireScopedIteration(scope(), stream)) out.push(value);
    await settle();
    server.stop(true);

    expect(out).toEqual([1, 2]);
    expect(seen.map((e) => e.url.endsWith("/first") || e.url.endsWith("/second"))).toEqual([
      true,
      true,
    ]);
    expect(seen.map((e) => e.seq)).toEqual([0, 1]);
  });

  test("the real Anthropic provider lands verbatim body bytes in the store", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-6",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");

    let servedBody = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        servedBody = await request.text();
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      },
    });

    const port = server.port;
    const store = CallStore.openInMemory();
    uninstall = installWireCapture((exchange) => {
      store.recordHttpCall(exchange);
    });

    const providers = captureProviders({ anthropic: new AnthropicProvider() }, store);
    const request: SidecarRequest = {
      sdk: "anthropic",
      model: "claude-opus-4-6",
      provider_key: "anthropic",
      api_key: "sk-ant-super-secret",
      base_url: `http://localhost:${port}`,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 64,
      replay_prior_thinking: "all",
      context: { character: "poppy", call_type: "message", thinking_enabled: false, rid: "r_1" },
    };

    const text: string[] = [];
    for await (const event of providers.anthropic!.stream(request)) {
      if (event.type === "text") text.push(event.text);
    }
    await settle();
    server.stop(true);

    expect(text.join("")).toBe("hello");

    const calls = store.queryCalls({ limit: 10 });
    expect(calls).toHaveLength(1);

    const wire = store.httpCallsFor(calls[0]!.call_id);
    expect(wire).toHaveLength(1);
    expect(wire[0]!.request_body).toBe(servedBody);
    expect(wire[0]!.response_body).toBe(sse);
    expect(wire[0]!.url).toBe(`http://localhost:${port}/v1/messages`);
    expect(wire[0]!.character).toBe("poppy");
    expect(wire[0]!.call_type).toBe("message");

    const headers = new Map(wire[0]!.request_headers);
    expect(headers.get("x-api-key")).toBe(REDACTED);

    const internal = store.getCall(calls[0]!.id);
    expect(internal?.request).not.toContain("sk-ant-super-secret");
    expect(wire[0]!.request_body).not.toContain("sk-ant-super-secret");

    const sent = JSON.parse(wire[0]!.request_body ?? "{}") as Record<string, unknown>;
    expect(sent["model"]).toBe("claude-opus-4-6");
    expect(sent["stream"]).toBe(true);

    store.close();
  });

  test("round-trips an exchange through the store byte for byte", async () => {
    const store = CallStore.openInMemory();
    const body = JSON.stringify({ system: "you are Rhia", messages: [] });

    store.recordHttpCall({
      call_id: "call-7",
      seq: 0,
      ts: new Date("2026-08-10T12:00:00.000Z"),
      character: "Rhia",
      call_type: "chat",
      rid: null,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      status: 200,
      status_text: "OK",
      duration_ms: 812,
      error: null,
      request_headers: [["x-api-key", "sk-ant-secret"]],
      request_body: new TextEncoder().encode(body),
      response_headers: [["content-type", "application/json"]],
      response_body: new TextEncoder().encode(`{"id":"msg_1"}`),
    });

    const rows = store.httpCallsFor("call-7");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.request_body).toBe(body);
    expect(rows[0]!.response_body).toBe(`{"id":"msg_1"}`);
    expect(rows[0]!.request_headers).toEqual([["x-api-key", "sk-ant-secret"]]);
    expect(rows[0]!.status).toBe(200);
    store.close();
  });
});
