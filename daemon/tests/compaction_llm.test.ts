import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fixture from "./memory_captures/compaction_llm.json";

import {
  resolveImageGenConfig,
  type ImageGenSettings,
} from "../src/llm/image_generate";
import { hardcodedProviderBaseUrl, type ResolvedModel } from "../src/llm/request";
import {
  countImageBlocks,
  readLearnedImageSupport,
  recordImageRejection,
} from "../src/llm/image_support";
import type { ProviderEntry } from "../src/llm/credentials";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types";
import {
  appendCompactionTail,
  COMPACTION_TAIL_ENTRY_COUNT,
  RealCompactionLlm,
} from "../src/memory/compaction/llm";
import { CompactionError } from "../src/memory/compaction/types";

type Json = Record<string, unknown>;
const fx = fixture as unknown as Record<string, Json[] | string>;
const section = (name: string): Json[] => fx[name] as Json[];

function cacheScratch(): string {
  return mkdtempSync(join(tmpdir(), "shore-compaction-llm-"));
}

function requestWithImage(): SidecarRequest {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "text", text: "look" },
        ],
      },
    ],
  } as unknown as SidecarRequest;
}

function okResponse(): GenerateResponse {
  return {
    content: "done",
    content_blocks: [],
    finish_reason: "end_turn",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: 0, time_to_first_token_ms: 0 },
    model: "m",
  };
}

const withoutDeadCitation = (err: string): string =>
  err.replace(" (see CONFIGURATION.md).", ".");

describe("hardcodedProviderBaseUrl", () => {
  for (const rec of section("hardcoded_base_url")) {
    const key = rec.provider_key as string;
    test(key === "" ? "(empty)" : key, () => {
      expect(hardcodedProviderBaseUrl(key)).toBe(
        (rec.base_url as string | null) ?? undefined,
      );
    });
  }
});

function providersFrom(
  recs: Json[],
): Record<string, { entry?: ProviderEntry; baseUrl?: string }> {
  const out: Record<string, { entry?: ProviderEntry; baseUrl?: string }> = {};
  for (const rec of recs) {
    const entry: ProviderEntry = {
      enabled: rec.enabled as boolean,
      keys: (rec.keys as Json[]).map((k) => ({
        name: k.name as string,
        env: k.env as string,
        enabled: k.enabled as boolean,
        warn_on_fallback: false,
      })),
    };
    out[rec.key as string] = {
      entry,
      ...(rec.base_url === null ? {} : { baseUrl: rec.base_url as string }),
    };
  }
  return out;
}

function envFrom(recs: Json[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const rec of recs) {
    const value = rec.value as string | null;
    if (value !== null) env[rec.var as string] = value;
  }
  return env;
}

function settingsFrom(recs: Json[]): Record<string, ImageGenSettings> {
  const out: Record<string, ImageGenSettings> = {};
  for (const rec of recs) {
    const s = rec.settings as Json;
    out[rec.key as string] = {
      ...(s.size === null ? {} : { size: s.size as string }),
      ...(s.quality === null ? {} : { quality: s.quality as string }),
      ...(s.aspect_ratio === null ? {} : { aspect_ratio: s.aspect_ratio as string }),
      ...(s.image_size === null ? {} : { image_size: s.image_size as string }),
    };
  }
  return out;
}

describe("resolveImageGenConfig", () => {
  for (const rec of section("resolve_image_gen_config")) {
    test(rec.name as string, () => {
      const result = resolveImageGenConfig({
        ...(rec.default_ref === null ? {} : { defaultRef: rec.default_ref as string }),
        imageGen: settingsFrom(rec.image_gen as Json[]),
        providers: providersFrom(rec.providers as Json[]),
        env: envFrom(rec.env as Json[]),
      });

      const expected = rec.result as { ok?: Json; err?: string };
      if (expected.err !== undefined) {
        expect(result).toEqual({ err: withoutDeadCitation(expected.err) });
        return;
      }
      expect("ok" in result).toBe(true);
      const ok = (result as unknown as { ok: Record<string, unknown> }).ok;
      const filled: Record<string, unknown> = {};
      for (const key of Object.keys(required(expected.ok))) filled[key] = ok[key] ?? null;
      expect(filled).toEqual(required(expected.ok));
      expect(Object.keys(ok).sort()).toEqual(
        Object.keys(required(expected.ok))
          .filter((k) => (expected.ok as Json)[k] !== null)
          .sort(),
      );
    });
  }
});

function modelFrom(rec: Json): ResolvedModel {
  return {
    provider_key: rec.provider_key as string,
    model_id: rec.model_id as string,
    sdk: rec.sdk as ResolvedModel["sdk"],
    ...(rec.api_key_env === null ? {} : { api_key_env: rec.api_key_env as string }),
    ...(rec.base_url === null ? {} : { base_url: rec.base_url as string }),
    ...(rec.max_output_tokens === null
      ? {}
      : { max_output_tokens: rec.max_output_tokens as number }),
    ...(rec.temperature === null ? {} : { temperature: rec.temperature as number }),
    ...(rec.top_p === null ? {} : { top_p: rec.top_p as number }),
    ...(rec.cache_ttl === null ? {} : { cache_ttl: rec.cache_ttl as string }),
    ...(rec.reasoning_effort === null
      ? {}
      : { reasoning_effort: rec.reasoning_effort as string }),
    ...(rec.budget_tokens === null ? {} : { budget_tokens: rec.budget_tokens as number }),
  } as ResolvedModel;
}

function chatFrom(rec: Json): SidecarRequest {
  return rec as unknown as SidecarRequest;
}

describe("RealCompactionLlm.buildInitialRequest", () => {
  for (const rec of section("build_initial_request")) {
    test(rec.name as string, () => {
      const providers = providersFrom(rec.providers as Json[]);
      const model = modelFrom(rec.model as Json);
      const providerEntry = providers[model.provider_key]?.entry;
      const llm = new RealCompactionLlm({
        model,
        ...(providerEntry === undefined ? {} : { providerEntry }),
        character: "Aria",
        generate: () => {
          throw new Error("generate is not exercised by this fixture");
        },
        cacheDir: cacheScratch(),
        env: envFrom(rec.env as Json[]),
      });

      const expected = rec.result as { ok?: Json; err?: string };
      let built: SidecarRequest | undefined;
      let error: string | undefined;
      try {
        built = llm.buildInitialRequest(
          "COMPACTION RULES",
          { role: "user", content: [{ type: "text", text: "compact now please" }] },
          chatFrom(rec.chat_request as Json),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(CompactionError);
        expect((e as CompactionError).kind).toBe("llm");
        error = (e as Error).message;
      }

      if (expected.err !== undefined) {
        expect(error).toBe(expected.err);
        return;
      }
      expect(error).toBeUndefined();
      expect(JSON.parse(JSON.stringify(built))).toEqual(required(expected.ok));
    });
  }

  test("the compaction turn stays in place throughout the tool loop", () => {
    const rec = required(section("build_initial_request").find(
      (r) => r.name === "chat prefix carried, model rebuilt",
    ));
    const chatPrefix = (rec.chat_request as Json).messages as unknown[];
    const built = (rec.result as { ok: Json }).ok.messages as Array<{ role: string }>;

    expect(built.length).toBe(chatPrefix.length + COMPACTION_TAIL_ENTRY_COUNT);
    expect(required(built.at(-1)).role).toBe("user");

    const before = JSON.stringify(built);
    const request = { messages: [...built] } as unknown as SidecarRequest;
    request.messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    request.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "done" }],
    });
    expect(JSON.stringify(request.messages.slice(0, built.length))).toBe(before);
  });

  test("the task and rules share a user turn without modifying the task", () => {
    const request = { messages: [] } as unknown as SidecarRequest;
    const task = { role: "user" as const, content: [{ type: "text" as const, text: "now" }] };
    appendCompactionTail(
      request,
      task,
      "instruction",
    );
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "now" }, { type: "text", text: "instruction" }], transient_tail: 1 },
    ]);
    expect(task.content).toEqual([{ type: "text", text: "now" }]);
    expect(request.messages.length).toBe(COMPACTION_TAIL_ENTRY_COUNT);
  });

  test("the caller's chat request is not appended to", () => {
    const chat: SidecarRequest = {
      sdk: "anthropic",
      model: "chat-model",
      api_key: "k",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 4096,
      replay_prior_thinking: "all",
    };
    const before = structuredClone(chat);
    const llm = new RealCompactionLlm({
      model: {
        provider_key: "anthropic",
        model_id: "m",
        sdk: "anthropic",
        api_key_env: "CMP_TEST_KEY",
      } as ResolvedModel,
      character: "Aria",
      generate: () => {
        throw new Error("not used");
      },
      cacheDir: cacheScratch(),
      env: { CMP_TEST_KEY: "sk-test" },
    });

    const built = llm.buildInitialRequest(
      "instruction",
      { role: "user", content: [{ type: "text", text: "now" }] },
      chat,
    );

    expect(built.messages.length).toBe(2);
    expect(chat).toEqual(before);
  });
});

describe("RealCompactionLlm.generate", () => {
  test("wraps a failure from the injected generate as an llm error", async () => {
    const llm = new RealCompactionLlm({
      model: { provider_key: "anthropic", model_id: "m", sdk: "anthropic" } as ResolvedModel,
      character: "Aria",
      generate: () => {
        throw new Error("upstream is down");
      },
      cacheDir: cacheScratch(),
    });
    expect(
      llm.generate({ messages: [] } as unknown as SidecarRequest),
    ).rejects.toThrow("llm: upstream is down");
  });

  test("passes the request, model and character through unchanged", async () => {
    const seen: unknown[] = [];
    const model = { provider_key: "anthropic", model_id: "m", sdk: "anthropic" } as ResolvedModel;
    const request = { messages: [] } as unknown as SidecarRequest;
    const llm = new RealCompactionLlm({
      model,
      character: "Aria",
      generate: async (req, m, character) => {
        seen.push(req, m, character);
        return {
          content: "done",
          content_blocks: [],
          finish_reason: "end_turn",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          timing: { total_ms: 0, time_to_first_token_ms: 0 },
          model: "m",
        };
      },
      cacheDir: cacheScratch(),
    });
    const resp = await llm.generate(request);
    expect(seen).toEqual([request, model, "Aria"]);
    expect(resp.content).toBe("done");
  });

  test("strips images when the model is already known to refuse them", async () => {
    const cacheDir = cacheScratch();
    recordImageRejection(cacheDir, "zai-sub", "glm-5.3");
    const sent: SidecarRequest[] = [];
    const request = requestWithImage();
    const llm = new RealCompactionLlm({
      model: {
        provider_key: "zai-sub",
        model_id: "glm-5.3",
        sdk: "zai",
      } as ResolvedModel,
      character: "Aria",
      generate: async (req) => {
        sent.push(req);
        return okResponse();
      },
      cacheDir,
    });

    await llm.generate(request);

    expect(sent.length).toBe(1);
    expect(countImageBlocks(required(sent[0]).messages)).toBe(0);
    expect(countImageBlocks(request.messages)).toBe(0);
    expect(JSON.stringify(request.messages)).toContain("image omitted");
  });

  test("records the refusal and retries without images when the provider rejects one", async () => {
    const cacheDir = cacheScratch();
    const seen: number[] = [];
    const request = requestWithImage();
    const llm = new RealCompactionLlm({
      model: {
        provider_key: "zai-sub",
        model_id: "glm-5.3",
        sdk: "zai",
      } as ResolvedModel,
      character: "Aria",
      generate: async (req) => {
        seen.push(countImageBlocks(req.messages));
        if (seen.length === 1) {
          throw new Error("400 messages.content.type is invalid, allowed values: ['text']");
        }
        return okResponse();
      },
      cacheDir,
    });

    const resp = await llm.generate(request);

    expect(seen).toEqual([1, 0]);
    expect(resp.content).toBe("done");
    expect(readLearnedImageSupport(cacheDir, "zai-sub")["glm-5.3"]).toBe(false);
    expect(countImageBlocks(request.messages)).toBe(0);
  });

  test("a rejection with no images left to drop is an llm error", async () => {
    const cacheDir = cacheScratch();
    let calls = 0;
    const llm = new RealCompactionLlm({
      model: {
        provider_key: "zai-sub",
        model_id: "glm-5.3",
        sdk: "zai",
      } as ResolvedModel,
      character: "Aria",
      generate: () => {
        calls += 1;
        throw new Error("400 messages.content.type is invalid, allowed values: ['text']");
      },
      cacheDir,
    });

    expect(
      llm.generate({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as unknown as SidecarRequest),
    ).rejects.toThrow("llm: 400 messages.content.type is invalid");
    expect(calls).toBe(1);
    expect(readLearnedImageSupport(cacheDir, "zai-sub")["glm-5.3"]).toBeUndefined();
  });
});

test("image fallback cannot replay a compaction run after a checkpointed response", async () => {
  let calls = 0;
  let checkpoints = 0;
  const llm = new RealCompactionLlm({
    model: { provider_key: "zai-sub", model_id: "glm-5.3", sdk: "zai" } as ResolvedModel,
    character: "Aria",
    cacheDir: cacheScratch(),
    generate: async (_req, _model, _character, _sink, phase) => {
      calls += 1;
      await phase?.onTurn?.(okResponse());
      throw new Error("400 messages.content.type is invalid, allowed values: ['text']");
    },
  });
  const failure = await llm.run(requestWithImage(), {
    messages: [],
    onTurn: () => { checkpoints += 1; },
    recordTurn: () => {},
    runTool: () => { throw new Error("unexpected tool"); },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CompactionError);
  expect(calls).toBe(1);
  expect(checkpoints).toBe(1);
});
