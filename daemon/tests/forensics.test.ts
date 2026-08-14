import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAnthropicPlan } from "../src/llm/providers/anthropic.ts";
import { recordCacheCall, type CachePlacement } from "../src/cache/forensics.ts";
import type { CallContext, SidecarRequest } from "../src/llm/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shore-forensics-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rows(): Array<Record<string, unknown>> {
  const raw = readFileSync(join(dir, "cache_forensics.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const USAGE = {
  input_tokens: 12,
  output_tokens: 3,
  cache_read_tokens: 10_313,
  cache_creation_tokens: 0,
};

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  character: "poppy",
  call_type: "message",
  thinking_enabled: true,
  forensics_dir: dir,
  ...over,
});

const PLACEMENT: CachePlacement = {
  msg_breakpoints: [4, 6, 8],
  sys_breakpoints: [2],
  msg_count: 9,
  sys_blocks: 3,
  cache_enabled: true,
  has_existing_markers: false,
  breakpoints_requested: 4,
  breakpoints_placed: 4,
  breakpoints_dropped_no_anchor: 0,
  breakpoints_dropped_over_limit: 0,
};

describe("cache forensics rows", () => {
  test("a row carries placement, usage, and the daemon's labels", () => {
    recordCacheCall(
      ctx({ character: "poppy", call_type: "keepalive", rid: "r-1" }),
      "claude-opus-5",
      PLACEMENT,
      USAGE,
      "done",
    );

    const [row] = rows();
    expect(row).toMatchObject({
      character: "poppy",
      call_type: "keepalive",
      rid: "r-1",
      model: "claude-opus-5",
      outcome: "done",
      msg_breakpoints: [4, 6, 8],
      sys_breakpoints: [2],
      cache_read_tokens: 10_313,
      cache_creation_tokens: 0,
    });
    expect(row).not.toHaveProperty("call_id");
  });

  test("no context at all → nothing is written", () => {
    recordCacheCall(undefined, "claude-opus-5", PLACEMENT, USAGE, "done");
    expect(() => rows()).toThrow();
  });

  test("a context with forensics off → nothing is written", () => {
    const { forensics_dir: _off, ...off } = ctx();
    recordCacheCall(off, "claude-opus-5", PLACEMENT, USAGE, "done");
    expect(() => rows()).toThrow();
  });

  test("rows append rather than overwrite", () => {
    const both = ctx({ character: "poppy" });
    recordCacheCall(both, "claude-opus-5", PLACEMENT, USAGE, "done");
    recordCacheCall(both, "claude-opus-5", PLACEMENT, USAGE, "error");
    expect(rows().map((r) => r["outcome"])).toEqual(["done", "error"]);
  });

  test("an unwritable directory does not throw into the call path", () => {
    expect(() =>
      recordCacheCall(
        ctx({ character: "p", forensics_dir: join(dir, "does", "not", "exist") }),
        "claude-opus-5",
        PLACEMENT,
        USAGE,
        "done",
      ),
    ).not.toThrow();
  });
});

describe("placement reported matches placement applied", () => {
  function req(messages: SidecarRequest["messages"]): SidecarRequest {
    return {
      sdk: "anthropic",
      model: "claude-opus-4-8",
      api_key: "k",
      messages,
      system: [{ text: "you are a character", label: "system" }],
      max_tokens: 64,
      provider_options: { cache_ttl: "1h" },
    } as SidecarRequest;
  }

  test("reported indices are the ones carrying cache_control", () => {
    const { params, placement } = buildAnthropicPlan(
      req([
        { role: "user", content: [{ type: "text", text: "one" }] },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
        { role: "user", content: [{ type: "text", text: "three" }] },
        { role: "assistant", content: [{ type: "text", text: "four" }] },
        { role: "user", content: [{ type: "text", text: "five" }] },
      ]),
    );

    expect(placement.cache_enabled).toBe(true);
    expect(placement.msg_breakpoints.length).toBeGreaterThan(0);

    const marked = params.messages
      .map((m, i) => ({ i, blocks: Array.isArray(m.content) ? m.content : [] }))
      .filter(({ blocks }) =>
        blocks.some((b) => (b as { cache_control?: unknown }).cache_control !== undefined),
      )
      .map(({ i }) => i);
    expect(marked).toEqual(placement.msg_breakpoints);
    expect(placement.msg_count).toBe(params.messages.length);
  });

  test("no cache_ttl → nothing placed and the row says so", () => {
    const noCache = { ...req([{ role: "user", content: [{ type: "text", text: "hi" }] }]), provider_options: {} };
    const { placement } = buildAnthropicPlan(noCache);
    expect(placement.cache_enabled).toBe(false);
    expect(placement.msg_breakpoints).toEqual([]);
    expect(placement.sys_breakpoints).toEqual([]);
  });
});
