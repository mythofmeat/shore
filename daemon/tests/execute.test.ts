import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fixture from "./tools_fixtures/execute.json" with { type: "json" };
import {
  attachGeneratedImage,
  executeToolUse,
  recordReportedMessage,
  runToolUse,
  type ToolExecution,
} from "../src/tools/execute.ts";
import type { ToolContext, ToolLimitsView } from "../src/tools/dispatch.ts";
import { ToolIoError } from "../src/tools/errors.ts";
import type { ImageGenerateResult } from "../src/tools/images.ts";
import type { ContentBlock, Message, Role } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

const SEARCH_CONFIG = {
  api_key_env: "TAVILY_API_KEY",
  result_limit: 5,
  search_depth: "basic",
  include_answer: true,
};
const RETRIEVAL_CONFIG = {
  maxFileBytes: 0,
  maxIndexedFiles: 0,
  maxTotalIndexedBytes: 0,
  maxEmbedCharsPerFile: 0,
  binary: "skip" as const,
};

const MINTED_ID = "m_00000000-0000-4000-8000-000000000000";
const MINTED_TS = "2026-01-01T00:00:00-05:00";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function normalise(value: unknown, tmpRoot?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => normalise(v, tmpRoot));
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && tmpRoot !== undefined
      ? value.replaceAll(tmpRoot, "<tmp>")
      : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === "duration_ms") {
      out[key] = "<duration_ms>";
    } else if (key === "msg_id" && val === MINTED_ID) {
      out[key] = "<minted_id>";
    } else if (key === "timestamp" && val === MINTED_TS) {
      out[key] = "<minted_timestamp>";
    } else if (key === "path" && typeof val === "string" && val.includes("/generated/")) {
      out[key] = `<generated>.${val.split(".").pop() ?? ""}`;
    } else {
      out[key] = normalise(val, tmpRoot);
    }
  }
  return out;
}

function stripAbsent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAbsent);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, stripAbsent(v)]),
  );
}

function withoutTruncationFields(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const { truncated: _t, result_chars: _c, ...rest } = value as Record<string, unknown>;
  return rest;
}

interface FixtureLimits {
  max_result_chars: number;
  timeout_ms: number;
  config: Record<string, { max_result_chars?: number | null; timeout?: string | null }> | null;
}

function limitsFrom(raw: FixtureLimits): ToolLimitsView {
  const overrides: Record<string, { max_result_chars?: number; timeout_ms?: number }> = {};
  for (const [name, o] of Object.entries(raw.config ?? {})) {
    overrides[name] = {
      ...(o.max_result_chars === null || o.max_result_chars === undefined
        ? {}
        : { max_result_chars: o.max_result_chars }),
      ...(o.timeout === null || o.timeout === undefined
        ? {}
        : { timeout_ms: durationMs(o.timeout) }),
    };
  }
  return {
    max_result_chars: raw.max_result_chars,
    timeout_ms: raw.timeout_ms,
    ...(Object.keys(overrides).length > 0 ? { config: overrides } : {}),
  };
}

function durationMs(raw: string): number {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(raw);
  if (m === null) throw new Error(`unparsed duration ${raw}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return n * 1000;
  }
}

function harness(rid: string | null, limits: ToolLimitsView, ctx: ToolContext) {
  const frames: ServerMessage[] = [];
  const exec: ToolExecution = {
    sendDirect: (m) => frames.push(m),
    ctx,
    limits,
    ...(rid !== null ? { rid } : {}),
    now: () => MINTED_TS,
    newMessageId: () => MINTED_ID,
    monotonicMs: () => 0,
  };
  return { exec, frames };
}

type Scripted = { ok: unknown } | { err: string } | { hang: true };

function scriptedContext(name: string, scripted: Scripted): ToolContext {
  const base: ToolContext = {
    imageDir: "",
    workspaceDir: "",
    characterDataDir: "",
    characterName: "",
    configDir: "",
    searchConfig: SEARCH_CONFIG,
    retrievalConfig: RETRIEVAL_CONFIG,
    retrievalMode: "auto",
  };
  if (!name.startsWith("ask_")) return base;
  return {
    ...base,
    runSubagent: async (_agent, _query, signal) => {
      if ("hang" in scripted) {
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if ("err" in scripted) throw new ToolIoError(scripted.err);
      return scripted.ok;
    },
  };
}

interface ExecCase {
  name: string;
  note: string;
  input: {
    tool: { id: string; name: string; input: unknown };
    scripted: Scripted;
    rid: string | null;
    limits: FixtureLimits;
    intermediate_messages: Message[];
  };
  output: unknown;
}

const TRUNCATION_FORMAT_DIVERGES = new Set([
  "a long result is truncated before anything sees it",
  "a per-tool cap outranks the global one",
  "an error result is truncated too",
]);

describe("execute_tool_use", () => {
  for (const c of fixture.execute_tool_use as unknown as ExecCase[]) {
    if (TRUNCATION_FORMAT_DIVERGES.has(c.name)) {
      test(`${c.name} (diverges: #92)`, async () => {
        const ctx = scriptedContext(c.input.tool.name, c.input.scripted);
        const { exec } = harness(c.input.rid, limitsFrom(c.input.limits), ctx);
        const run = await runToolUse(
          c.input.tool,
          exec,
          structuredClone(c.input.intermediate_messages),
        );

        const cap = limitsFrom(c.input.limits);
        const kept =
          cap.config?.[c.input.tool.name]?.max_result_chars ?? cap.max_result_chars;
        const content = (run.block as { content: string }).content;
        const window = run.window;

        expect(window?.truncated).toBe(true);
        expect(window?.originalChars ?? 0).toBeGreaterThan(kept);
        expect(content).toContain(`${String(window?.originalChars ?? 0)} characters`);
        expect(content).toContain("Narrow the call");
        const [head, tail] = content.split("\n\n[tool_result truncated:");
        expect(head?.length ?? 0).toBeGreaterThan(0);
        expect((tail ?? "").split("to see the rest.]\n\n")[1]?.length ?? 0).toBeGreaterThan(0);
      });
      continue;
    }
    test(c.name, async () => {
      const ctx = scriptedContext(c.input.tool.name, c.input.scripted);
      const { exec, frames } = harness(c.input.rid, limitsFrom(c.input.limits), ctx);
      const messages = structuredClone(c.input.intermediate_messages);

      const block = await executeToolUse(c.input.tool, exec, messages);

      expect(
        normalise(
          stripAbsent({
            block: withoutTruncationFields(block),
            frames,
            intermediate_messages: messages,
          }),
        ),
      ).toEqual(c.output as never);
    });
  }
});

interface ImageCase {
  name: string;
  note: string;
  input: { caption: string | null; intermediate_messages: Message[] };
  output: unknown;
}

describe("generate_image", () => {
  for (const c of fixture.generate_image as unknown as ImageCase[]) {
    test(c.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "shore-exec-img-"));
      try {
        const ctx: ToolContext = {
          imageDir: join(root, "images"),
          workspaceDir: "",
          characterDataDir: "",
          characterName: "",
          configDir: "",
          searchConfig: SEARCH_CONFIG,
          retrievalConfig: RETRIEVAL_CONFIG,
          retrievalMode: "auto",
          imageGenConfig: {
            provider: "openrouter",
            model_id: "test/image",
            api_key: "sk-test",
            size: "1024x1024",
          },
          imageGenerator: (): Promise<ImageGenerateResult> =>
            Promise.resolve({
              url: PNG_DATA_URL,
              revised_prompt: "a better prompt",
              timing: { total_ms: 5 },
            }),
        };
        const { exec, frames } = harness("r-img", { max_result_chars: 0, timeout_ms: 0 }, ctx);
        const messages = structuredClone(c.input.intermediate_messages);

        const block = await executeToolUse(
          {
            id: "tu_img",
            name: "generate_image",
            input: {
              prompt: "a cat",
              ...(c.input.caption !== null ? { caption: c.input.caption } : {}),
            },
          },
          exec,
          messages,
        );

        expect(
          normalise(
            stripAbsent({
              block:
                block.type === "tool_result"
                  ? { tool_use_id: block.tool_use_id, is_error: block.is_error ?? false }
                  : { unexpected: block.type },
              frames: frames.map((f) =>
                f.type === "tool_result" ? { ...f, output: "<handler_json>" } : f,
              ),
              intermediate_messages: messages,
            }),
          ),
        ).toEqual(c.output as never);

        const written = await readdir(join(root, "images", "generated"));
        expect(written).toHaveLength(1);
        expect(written[0]).toMatch(/^\d{8}_\d{6}\.png$/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

interface AttachCase {
  name: string;
  note: string;
  input: { rid: string | null; value: unknown; intermediate_messages: Message[] };
  output: unknown;
}

describe("attach_generated_image", () => {
  for (const c of fixture.attach_generated_image as unknown as AttachCase[]) {
    test(c.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "shore-exec-attach-"));
      try {
        await writeFile(join(root, "real.png"), Buffer.from("89504e470d0a1a0a", "hex"));
        const value = JSON.parse(
          JSON.stringify(c.input.value).replaceAll("<tmp>", root),
        ) as unknown;

        const frames: ServerMessage[] = [];
        const messages = structuredClone(c.input.intermediate_messages);
        attachGeneratedImage(value, messages, {
          sendDirect: (m) => frames.push(m),
          ...(c.input.rid !== null ? { rid: c.input.rid } : {}),
        });

        expect(
          normalise(stripAbsent({ frames, intermediate_messages: messages }), root),
        ).toEqual({
          frames: (c.output as { frames: unknown[] }).frames,
          intermediate_messages: (c.output as { intermediate_messages: unknown })
            .intermediate_messages,
        } as never);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

interface ReportedCase {
  name: string;
  note: string;
  input: { role: Role; blocks: ContentBlock[] };
  output: unknown;
}

describe("record_reported_message", () => {
  for (const c of fixture.record_reported_message as unknown as ReportedCase[]) {
    test(c.name, () => {
      const messages: Message[] = [];
      recordReportedMessage(messages, c.input.role, c.input.blocks, {
        now: () => MINTED_TS,
        newMessageId: () => MINTED_ID,
      });
      expect(normalise(stripAbsent(messages))).toEqual(c.output as never);
    });
  }
});

describe("minted values", () => {
  const observed = fixture._observed as Record<string, unknown>;

  test("a minted message id is `m_<uuid v4>`", () => {
    expect(observed["msg_id"]).toMatch(
      /^m_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(MINTED_ID).toMatch(
      /^m_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("a minted timestamp is RFC 3339 with an offset", () => {
    expect(observed["timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/);
    expect(MINTED_TS).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/);
  });

  test("a dispatch duration is a whole number of milliseconds", () => {
    expect(Number.isInteger(observed["duration_ms"])).toBe(true);
  });

  test("a generated image is named for the second it was written", () => {
    expect(observed["generated_path"]).toMatch(/\/generated\/\d{8}_\d{6}\.png$/);
  });
});

describe("the cap a tool result is held to", () => {
  const LONG = "x".repeat(120);

  async function run(limits: ToolLimitsView) {
    const ctx = scriptedContext("ask_research", { ok: LONG });
    const { exec, frames } = harness(null, limits, ctx);
    const out = await runToolUse(
      { id: "tu_cap", name: "ask_research", input: { query: "who" } },
      exec,
      [],
    );
    const frame = frames.find((f) => f.type === "tool_result") as
      | { output: string }
      | undefined;
    return { content: (out.block as { content: string }).content, frame, window: out.window };
  }

  test("a per-tool override is used in place of the global cap", async () => {
    const { content, window } = await run({
      max_result_chars: 1000,
      timeout_ms: 300_000,
      config: { ask_research: { max_result_chars: 40 } },
    });

    expect(window?.truncated, "40 is the tool's own cap; the global 1000 would not truncate").toBe(
      true,
    );
    expect(window?.originalChars).toBe(LONG.length);
    expect(content).not.toBe(LONG);
  });

  test("the frame the client sees carries the capped result, not the raw one", async () => {
    const { content, frame } = await run({
      max_result_chars: 40,
      timeout_ms: 300_000,
      config: {},
    });

    expect(frame?.output).toBe(content);
    expect(frame?.output).not.toBe(LONG);
  });
});
