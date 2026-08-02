/**
 * Replay of `tests/memory_fixtures/compaction_llm_parity.json` — the rest of
 * `memory/compaction_impls.rs`.
 *
 * Every value came out of the real Rust: `resolve_image_gen_config` and
 * `RealCompactionLlm::build_initial_request`, driven with real environment
 * variables and real `[providers.*]` TOML.
 *
 * `RealCompactionLlm::generate` is not here. It reached
 * `LedgerClient::generate_with_credential_fallback`, which posted to the
 * sidecar over HTTP — in one process it becomes a direct provider call, and
 * that entry point lands with `handler/`. What this pins is the half that is
 * this module's: the request the compaction pass sends.
 */

import { describe, expect, test } from "bun:test";

import fixture from "./memory_fixtures/compaction_llm_parity.json";

import {
  resolveImageGenConfig,
  type ImageGenSettings,
} from "../src/llm/image_generate";
import { hardcodedProviderBaseUrl, type ResolvedModel } from "../src/llm/request";
import type { ProviderEntry } from "../src/llm/credentials";
import type { SidecarRequest } from "../src/llm/types";
import {
  appendCompactionTail,
  COMPACTION_TAIL_ENTRY_COUNT,
  RealCompactionLlm,
} from "../src/memory/compaction/llm";
import { CompactionError } from "../src/memory/compaction/types";

type Json = Record<string, unknown>;
const fx = fixture as unknown as Record<string, Json[] | string>;
const section = (name: string): Json[] => fx[name] as Json[];

// ── The provider base-url column ────────────────────────────────────────

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

// ── Image generation config ─────────────────────────────────────────────

/** Rebuild the fixture's `[providers.*]` section as this port models it. */
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

/** The fixture's `env` list as a lookup, with absent values genuinely absent. */
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
        expect(result).toEqual({ err: expected.err });
        return;
      }
      // The Rust struct writes every field; this port omits the absent ones,
      // which is the same value with fewer keys. Compared with `null` filled
      // back in so a dropped field cannot pass as an absent one.
      expect("ok" in result).toBe(true);
      const ok = (result as unknown as { ok: Record<string, unknown> }).ok;
      const filled: Record<string, unknown> = {};
      for (const key of Object.keys(expected.ok!)) filled[key] = ok[key] ?? null;
      expect(filled).toEqual(expected.ok!);
      // …and no field the Rust did not have.
      expect(Object.keys(ok).sort()).toEqual(
        Object.keys(expected.ok!)
          .filter((k) => (expected.ok as Json)[k] !== null)
          .sort(),
      );
    });
  }
});

// ── The compaction request ──────────────────────────────────────────────

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

/**
 * The chat-shape request as the port models it.
 *
 * The fixture's copy is the *serialized* `LlmRequest`, so its transient fields
 * (`api_key_name`, `rid`, `forensic_character`, `retain_long`) are already
 * absent — which is exactly why `SidecarRequest` does not carry them.
 */
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
        env: envFrom(rec.env as Json[]),
      });

      const expected = rec.result as { ok?: Json; err?: string };
      let built: SidecarRequest | undefined;
      let error: string | undefined;
      try {
        built = llm.buildInitialRequest(
          "SYSTEM INSTRUCTION",
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
      // `JSON.parse(JSON.stringify(...))` drops `undefined`-valued keys, which
      // is what serde's `skip_serializing_if` did on the other side.
      expect(JSON.parse(JSON.stringify(built))).toEqual(expected.ok!);
    });
  }

  /**
   * The invariant the whole shape exists for, asserted on the built request
   * rather than trusted: the compaction tail is exactly two entries, the
   * instruction is the second, and — because the loop appends after both — the
   * bytes at and before the instruction's index never move.
   */
  test("the tail is two entries and the instruction sits at a fixed index", () => {
    const rec = section("build_initial_request").find(
      (r) => r.name === "chat prefix carried, model rebuilt",
    )!;
    const chatPrefix = (rec.chat_request as Json).messages as unknown[];
    const built = (rec.result as { ok: Json }).ok.messages as Array<{ role: string }>;

    expect(built.length).toBe(chatPrefix.length + COMPACTION_TAIL_ENTRY_COUNT);
    expect(built.at(-2)!.role).toBe("user");
    expect(built.at(-1)!.role).toBe("system");

    // Appending a round's turns leaves the prefix up to the instruction intact.
    const before = JSON.stringify(built);
    const request = { messages: [...built] } as unknown as SidecarRequest;
    request.messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    request.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "done" }],
    });
    expect(JSON.stringify(request.messages.slice(0, built.length))).toBe(before);
  });

  test("appendCompactionTail is the two pushes, in that order", () => {
    const request = { messages: [] } as unknown as SidecarRequest;
    appendCompactionTail(
      request,
      { role: "user", content: [{ type: "text", text: "now" }] },
      "instruction",
    );
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "now" }] },
      { role: "system", content: [{ type: "text", text: "instruction" }] },
    ]);
    expect(request.messages.length).toBe(COMPACTION_TAIL_ENTRY_COUNT);
  });

  /**
   * The Rust took `chat_request` by value, so its `messages` were moved into
   * the rebuilt request and the caller had nothing left to alias. The port's
   * caller keeps its object, and the first replay of this fixture caught the
   * consequence: the compaction tail was being appended into the *chat*
   * request's array. On the warm-cache path that array is the autonomy
   * manager's cached `last_request`, so a compaction would have written its
   * "compact now" turn, its instruction, and every tool-loop round into chat's
   * own history.
   */
  test("the caller's chat request is not appended to", () => {
    const chat: SidecarRequest = {
      sdk: "anthropic",
      model: "chat-model",
      api_key: "k",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 4096,
      replay_prior_thinking: "all",
    };
    const before = JSON.parse(JSON.stringify(chat));
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
      env: { CMP_TEST_KEY: "sk-test" },
    });

    const built = llm.buildInitialRequest(
      "instruction",
      { role: "user", content: [{ type: "text", text: "now" }] },
      chat,
    );

    expect(built.messages.length).toBe(3);
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
    });
    await expect(
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
    });
    const resp = await llm.generate(request);
    expect(seen).toEqual([request, model, "Aria"]);
    expect(resp.content).toBe("done");
  });
});
