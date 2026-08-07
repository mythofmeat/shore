/**
 * Replay of the generation driver against the frozen Rust fixture.
 *
 * `tests/handler_fixtures/generation_parity.json` was generated in a worktree
 * at `9023b46d` by driving the real `handle_generation` against a fake sidecar
 * on a Unix socket — real registry, real engine, real `active.jsonl`, real tool
 * socket, real persistence. Nothing regenerates it; a diff here is a defect in
 * `src/handler/generation.ts`, not a fixture to refresh.
 *
 * # What stands in for the fake sidecar
 *
 * The generator's fake answered one HTTP call with canned NDJSON, optionally
 * calling back over the tool socket first. Here the same script is played by a
 * fake *provider* (for turns with no tools) and a fake *loop* (for the one that
 * has them) — `deps.loopEvents`. That substitution is deliberate: the Anthropic
 * loop is the SDK's own tool runner and cannot be fed recorded events, and both
 * real loops are pinned by their own tests. What this file is testing is the
 * driver around them.
 *
 * # Three recorded values have no counterpart here, and are not asserted
 *
 * - `broadcast_events` of type `history`. Those are the Rust
 *   `ConversationEngine`'s own push on append, not the driver's; only
 *   `new_message` is the driver's, and that is what is compared.
 * - `build_tool_context`'s `markdown_store` and `autonomy_manager_present`.
 *   Neither has a slot on the TypeScript `ToolContext` — see the note in
 *   `src/handler/tool_context.ts`.
 * - `subagent_conversation_len`. The sub-agent runtime is unported, so nothing
 *   receives the tail; the driver still computes it, and the `[subagents.*]`
 *   gate is what the replay checks instead.
 *
 * # Two assertions are not fixture-driven, and say so where they are made
 *
 * That the compaction check runs *after* the persisted `stream_end`, and that a
 * turn aborted by its signal stops. The first is a race in the Rust (a detached
 * `tokio::spawn`) and so is unrecordable; the second is only visible from
 * inside a generation, and the Rust's generations reached an LLM.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import fixture from "./handler_fixtures/generation_parity.json" with { type: "json" };
import { ConversationEngine } from "../src/engine/conversation.ts";
import { characterActiveJsonl } from "../src/config/dirs.ts";
import type { Message } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { emptyCatalog, NO_CHAT_MODELS_MESSAGE } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { ResolvedModel } from "../src/config/models.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  WireMessage,
} from "../src/llm/types.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ContentBlock } from "../src/engine/types.ts";
import {
  applyIntermediateMessages,
  generationEngine,
  runGeneration,
  type GenerationDeps,
} from "../src/handler/generation.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import type { TurnAutonomy } from "../src/handler/turn.ts";

// ── normalisation, mirroring the generator ──────────────────────────────

const MINTED_TS = "2026-01-01T00:00:00-05:00";
const MINTED_ID_RE = /^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Timestamps a case seeded. Anything else on a message was minted by the run. */
let seededTimestamps = new Set<string>();

function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "msg_id" && typeof val === "string" && MINTED_ID_RE.test(val)) {
        out[k] = "<minted_id>";
      } else if (
        k === "timestamp" &&
        typeof val === "string" &&
        !seededTimestamps.has(val)
      ) {
        out[k] = "<minted_timestamp>";
      } else if (k === "api_key") {
        out[k] = "<redacted>";
      } else if (k === "total_ms" || k === "ttft_ms") {
        out[k] = "<ms>";
      } else {
        out[k] = normalise(val);
      }
    }
    return out;
  }
  return v;
}

/**
 * Drop keys the Rust omits via `skip_serializing_if`, so a TypeScript object
 * carrying an explicit `undefined` or `null` compares equal to a frame the Rust
 * simply did not write. Same treatment the other parity replays apply, and it
 * is what `subagent` needs: the Rust omits `None`, the generated `.d.ts` makes
 * the field required so this side sends `null`, and a client reads them the
 * same because the field is `#[serde(default)]` on the way back in.
 */
function pruned(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pruned);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined || val === null) continue;
      if (Array.isArray(val) && val.length === 0 && (k === "alternatives" || k === "images")) {
        continue;
      }
      out[k] = pruned(val);
    }
    return out;
  }
  return v;
}

const shaped = (v: unknown): unknown => pruned(normalise(v));

/** Replace the per-run temp root with `<root>`, as the generator did. */
function stripRoot(s: string, root: string): string {
  return s.startsWith(root) ? `<root>${s.slice(root.length)}` : s;
}

// ── config ──────────────────────────────────────────────────────────────

interface Knobs {
  tools_enabled?: string[] | null;
  subagent?: string | null;
  image_generation?: string | null;
  embedding?: string | null;
  embedding_key_set?: boolean;
  search_depth?: string | null;
  max_retries?: number;
  /** Seed the catalog with the fixture's model. Only the turn cases need one. */
  with_model?: boolean;
}

/** The generator's `loaded_config`, rebuilt on this side. */
async function loadedConfig(root: string, knobs: Knobs): Promise<LoadedConfig> {
  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const app: AppConfig = defaultAppConfig();
  if (knobs.tools_enabled != null) app.tools.enabled_tools = [...knobs.tools_enabled];
  if (knobs.subagent != null) {
    app.subagents.set(knobs.subagent, {
      description: `the ${knobs.subagent} sub-agent`,
      prompt: "you are a sub-agent",
      tools: [],
      model: "anthropic:claude-x",
      max_iterations: undefined,
    });
  }
  if (knobs.image_generation != null) app.defaults.image_generation = knobs.image_generation;
  if (knobs.embedding != null) app.defaults.embedding = knobs.embedding;
  if (knobs.search_depth != null) app.tools.web_search.search_depth = knobs.search_depth;
  if (knobs.max_retries !== undefined) app.advanced.max_retries = knobs.max_retries;

  const models = emptyCatalog();
  // The generator handed `handle_generation` a `ResolvedModel` directly, as the
  // Rust handler does. This side resolves the active model itself, so the same
  // model goes in the catalog and is named as the default — the resolution is
  // pinned separately by `handler_active_model.test.ts`.
  if (knobs.with_model === true) {
    models.chat.set("chat.fixture", model());
    app.defaults.model = "fixture";
  }
  if (knobs.image_generation != null) {
    models.imageGeneration.set(knobs.image_generation, { size: "512x512" });
  }

  let providers = ProviderRegistry.empty();
  if (knobs.image_generation != null || knobs.embedding_key_set === true) {
    const env = knobs.image_generation != null ? IMAGE_KEY_ENV : EMBED_KEY_ENV;
    process.env[env] = "fixture-key";
    providers = ProviderRegistry.fromSection({
      openai: { keys: [{ name: "default", env }] },
    });
  }

  return { app, models, providers, dirs, rawTable: undefined };
}

const IMAGE_KEY_ENV = "SHORE_FIXTURE_IMAGE_KEY";
const EMBED_KEY_ENV = "SHORE_FIXTURE_EMBED_KEY";
const MODEL_KEY_ENV = "SHORE_FIXTURE_API_KEY";

/** The generator's `model()`. Anthropic throughout — see the fixture note. */
function model(): ResolvedModel {
  return {
    name: "fixture",
    qualifiedName: "chat.fixture",
    category: "chat",
    providerKey: "anthropic",
    sdk: "anthropic",
    modelId: "claude-fixture",
    apiKeyEnv: MODEL_KEY_ENV,
    maxContextTokens: 200_000,
    maxOutputTokens: 4096,
    maxToolIterations: 4,
  } as ResolvedModel;
}

async function tempRoot(name: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `shore-gen-${name}-`));
}

// ── apply_intermediate_messages ─────────────────────────────────────────

describe("applyIntermediateMessages", () => {
  for (const c of fixture.apply_intermediate_messages) {
    test(c.name, () => {
      const input = c.input as Record<string, any>;
      seededTimestamps = new Set(
        (input["messages"] as Message[]).map((m) => m.timestamp),
      );

      const base: WireMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
      const request = {
        model: "claude-fixture",
        messages: [base],
        ...(input["provider_key"] === null ? {} : { provider_key: input["provider_key"] }),
      } as SidecarRequest;

      applyIntermediateMessages(request, input["messages"] as Message[], input["result_model"]);

      expect(shaped(request.messages)).toEqual(shaped(c.output.messages));
    });
  }
});

// ── build_tool_context ──────────────────────────────────────────────────

describe("buildToolContext", () => {
  for (const c of fixture.build_tool_context) {
    test(c.name, async () => {
      const input = c.input as Record<string, any>;
      const out = c.output as Record<string, any>;
      const root = await tempRoot("tc");
      const config = await loadedConfig(root, input as Knobs);

      await mkdir(join(config.dirs.config, "characters", "ada"), { recursive: true });
      const workspace = join(config.dirs.config, "characters", "ada", "workspace");
      await mkdir(workspace, { recursive: true });
      for (const name of input["prompt_files"] as string[]) {
        await writeFile(join(workspace, name), `# ${name}`);
      }
      await mkdir(join(config.dirs.data, "ada"), { recursive: true });

      const ctx = await buildToolContext(config, config.dirs.data, "ada", {
        mcpRegistry: { call: async () => undefined },
        // Always passed, so what the fixture's `subagent_runtime` is recording
        // — the `[subagents.*]` gate — is the only thing that can decide it.
        runSubagent: () => async () => undefined,
      });

      expect(stripRoot(ctx.imageDir, root)).toBe(out["image_dir"]);
      expect(stripRoot(ctx.workspaceDir, root)).toBe(out["workspace_dir"]);
      expect(stripRoot(ctx.characterDataDir, root)).toBe(out["character_data_dir"]);
      expect(stripRoot(ctx.configDir, root)).toBe(out["config_dir"]);
      expect(ctx.characterName).toBe(out["character_name"]);
      expect(stripRoot(ctx.memoryIndexPath ?? "", root)).toBe(out["memory_index_path"]);
      expect(ctx.embedder !== undefined).toBe(out["embedder"]);
      expect(ctx.mcpCall !== undefined).toBe(out["mcp_registry"]);
      expect(ctx.runSubagent !== undefined).toBe(out["subagent_runtime"]);

      if (out["image_gen_config"] === null) {
        expect(ctx.imageGenConfig).toBeUndefined();
      } else {
        const cfg = out["image_gen_config"] as Record<string, unknown>;
        expect(ctx.imageGenConfig?.provider).toBe(cfg["provider"] as string);
        expect(ctx.imageGenConfig?.model_id).toBe(cfg["model_id"] as string);
        expect((ctx.imageGenConfig?.api_key ?? "") !== "").toBe(cfg["api_key_present"] as boolean);
        expect(ctx.imageGenConfig?.size).toBe(cfg["size"] as string);
      }

      // The search config crosses unchanged; the retrieval config is the same
      // values under camelCase names.
      expect(ctx.searchConfig.search_depth).toBe(out["search_config"]["search_depth"]);
      expect(ctx.searchConfig.result_limit).toBe(out["search_config"]["result_limit"]);
      expect(ctx.retrievalConfig.maxFileBytes).toBe(
        out["memory_retrieval_config"]["max_file_bytes"],
      );
      expect(ctx.retrievalMode).toBe(out["memory_retrieval_config"]["mode"]);

      // The side effect: the snapshot the deferred-edit queue diffs against.
      const snapshot = readdirSync(join(config.dirs.data, "ada", "active_prompt")).sort();
      expect(snapshot).toEqual(out["active_prompt_snapshot"] as string[]);
    });
  }
});

// ── handle_generation ───────────────────────────────────────────────────

/** Everything one replayed turn recorded. */
interface Run {
  direct: ServerMessage[];
  broadcast: ServerMessage[];
  requests: SidecarRequest[];
  lastRequest: unknown;
  error?: string;
  /** Where in `direct` the compaction gate was consulted, or -1. */
  compactionCheckedAfter: number;
  autonomyCalls: string[];
  dataDir: string;
  turnCount: number;
}

/** The generator's `ToolStep`s, played against the phase the driver built. */
async function* scriptedLoop(
  steps: readonly Record<string, any>[],
  events: readonly StreamEvent[],
  phase: ToolPhase,
): AsyncIterable<StreamEvent> {
  for (const step of steps) {
    if (step["kind"] === "messages") {
      for (const m of step["messages"] as { role: string; content_blocks: ContentBlock[] }[]) {
        phase.recordTurn(m.role as Message["role"], m.content_blocks);
      }
    } else {
      await phase.runTool({
        id: step["tool_id"] as string,
        name: step["name"] as string,
        input: step["input"],
      });
    }
  }
  yield* events;
}

async function replayTurn(c: Record<string, any>): Promise<Run> {
  const input = c["input"] as Record<string, any>;
  const root = await tempRoot("run");
  const config = await loadedConfig(root, {
    with_model: true,
    tools_enabled: input["tools_enabled"],
    subagent: input["subagent"],
    ...(input["max_retries"] === undefined ? {} : { max_retries: input["max_retries"] }),
  });
  process.env[MODEL_KEY_ENV] = "fixture-key";

  await mkdir(join(config.dirs.config, "characters", "ada"), { recursive: true });
  await writeFile(join(config.dirs.config, "characters", "ada", "character.md"), "ada system prompt");
  const charDir = join(config.dirs.data, "ada");
  await mkdir(charDir, { recursive: true });

  const history = input["history"] as Message[];
  seededTimestamps = new Set(history.map((m) => m.timestamp));
  if (history.length > 0) {
    await writeFile(
      join(charDir, "active.jsonl"),
      history.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
  }

  const direct: ServerMessage[] = [];
  const broadcast: ServerMessage[] = [];
  const requests: SidecarRequest[] = [];
  const steps = input["tool_steps"] as Record<string, any>[];
  const events = input["events"] as StreamEvent[];

  const provider: SidecarProvider = {
    // eslint-disable-next-line require-yield
    async *stream(req) {
      requests.push(req);
      yield* events;
    },
    generate: () => {
      throw new Error("no case generates");
    },
  };

  let lastRequest: unknown;
  let compactionCheckedAfter = -1;
  const autonomyCalls: string[] = [];
  const autonomy: TurnAutonomy & GenerationDeps["autonomy"] = {
    ensureState: () => {
      autonomyCalls.push("ensureState");
      return false;
    },
    backfillActivity: () => {},
    onUserMessage: () => {
      autonomyCalls.push("onUserMessage");
    },
    shouldCompactNow: () => {
      autonomyCalls.push("shouldCompactNow");
      // Not fixture-driven, and cannot be: the Rust spawned this check on a
      // detached task, so how many frames had gone out when it ran was a race.
      // What is recorded here is how much of the stream preceded it, which is
      // the ordering the assertion below pins.
      compactionCheckedAfter = direct.length;
      return false;
    },
    onCompactionComplete: () => {},
    onCompactionFailed: () => {},
    notifyLastRequest: (_c, request) => {
      autonomyCalls.push("notifyLastRequest");
      lastRequest = request;
    },
    notifyAssistantMessage: () => {
      autonomyCalls.push("notifyAssistantMessage");
    },
  };

  const engine = generationEngine(
    await ConversationEngine.load("ada", config.dirs.data, undefined),
  );

  const deps: GenerationDeps = {
    registry: {
      getOrCreate: async () => engine,
      effectiveConfig: () => config,
    },
    dataDir: config.dirs.data,
    providers: { anthropic: provider },
    autonomy,
    notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
    sessionTokens: { input: 0, output: 0 } as GenerationDeps["sessionTokens"],
    diagnostics: { api_calls: { push: () => {} }, tool_calls: { push: () => {} }, key_fallbacks: { push: () => {} } },
    emitEvent: (m) => broadcast.push(m),
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => 0, applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [],
    now: () => MINTED_TS,
    newMessageId: () => `m_${crypto.randomUUID()}`,
    monotonicMs: () => 0,
    sleep: async () => {},
    ...(steps.length === 0
      ? {}
      : {
          loopEvents: (_p, req, phase) => {
            requests.push(req);
            return scriptedLoop(steps, events, phase);
          },
        }),
  };

  let error: string | undefined;
  try {
    await runGeneration(deps, {
      meta: {
        session: {
          clientId: 1,
          sessionId: 1,
          clientType: "test-client",
          clientName: "test-1",
          capabilities: ["streaming"],
          selectedCharacter: "ada",
        },
        rid: input["rid"],
        kind: "message",
      } as never,
      // The Rust omits empty vectors via `skip_serializing_if`, so a body with
      // no images has neither key.
      body: {
        rid: input["rid"] ?? null,
        text: input["body"]["text"],
        stream: true,
        images: input["body"]["images"] ?? [],
        image_data: input["body"]["image_data"] ?? [],
      },
      regen: input["regen"] as boolean,
      charName: "ada",
      rid: input["rid"] ?? null,
      send: async (m) => {
        direct.push(m);
      },
      signal: new AbortController().signal,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    if (process.env["SHORE_DEBUG_REPLAY"] === "1") console.error("REPLAY ERROR:", e);
  }

  return {
    direct,
    broadcast,
    requests,
    lastRequest,
    ...(error === undefined ? {} : { error }),
    compactionCheckedAfter,
    autonomyCalls,
    dataDir: config.dirs.data,
    turnCount: engine.turnCount(),
  };
}

/** Drop the two fields the sidecar hop needed and this side has no use for. */
function stripHopFields(cached: unknown): unknown {
  if (cached === null || typeof cached !== "object") return cached;
  const { tool_rpc: _hop, max_tool_iterations: _cap, ...rest } = cached as Record<string, unknown>;
  return rest;
}

/** Drop `is_error: false` from `tool_result` blocks — see the note at the call. */
function dropFalseIsError(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropFalseIsError);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "is_error" && val === false) continue;
      out[k] = dropFalseIsError(val);
    }
    return out;
  }
  return v;
}

/** A case's `input`, typed loosely — every field is fixture JSON. */
function input(c: unknown): Record<string, any> {
  return (c as Record<string, any>)["input"] as Record<string, any>;
}

/** The conversation as it now stands on disk, read back through a fresh engine. */
async function readBack(dataDir: string): Promise<readonly Message[]> {
  const engine = await ConversationEngine.load("ada", dataDir, undefined);
  return engine.messages();
}

describe("runGeneration", () => {
  for (const c of fixture.handle_generation) {
    test(c.name, async () => {
      const run = await replayTurn(c as Record<string, any>);
      const out = c.output as Record<string, any>;

      // The frames the driver itself sends, in order.
      expect(shaped(run.direct)).toEqual(shaped(out["direct_frames"]));

      // Only `new_message` is the driver's; `history` is the Rust engine's own
      // push on append, and has no counterpart on this side.
      const expectedBroadcast = (out["broadcast_events"] as Record<string, unknown>[]).filter(
        (m) => m["type"] === "new_message",
      );
      expect(shaped(run.broadcast)).toEqual(shaped(expectedBroadcast));

      // What the provider was actually sent, labels included. `tool_rpc` is
      // dropped from the recorded side: it is the socket path and loop id the
      // sidecar called back on, and it died with the hop.
      const expectedRequests = (out["sidecar_requests"] as Record<string, unknown>[]).map(
        ({ tool_rpc: _hop, ...rest }) => rest,
      );
      expect(shaped(run.requests)).toEqual(shaped(expectedRequests));

      // The conversation as it now stands on disk, read back through a fresh
      // engine rather than the one the turn held.
      expect(shaped(await readBack(run.dataDir))).toEqual(shaped(out["conversation"]));
      expect(run.turnCount).toBe(out["turn_count"] as number);

      // The body every `last_request` reuse path clones. A turn's tool
      // exchanges have to be in it or the keepalive ping rewrites the
      // conversation it was meant to keep warm.
      // `rid` is `#[serde(skip)]` on the Rust request, so it lived in memory
      // and never reached the recorded JSON. It is dropped here for the same
      // reason `pruned` drops the `skip_serializing_if` fields.
      // Two fields on the recorded body belonged to the hop and have no
      // counterpart: `tool_rpc` (the callback socket and loop id) and
      // `max_tool_iterations`, which the Rust had to put on the shared request
      // because that was the only way to tell the sidecar the cap. Here the cap
      // rides on the call the loop is given and never on the conversation body.
      //
      // And `is_error: false` on a `tool_result`: the Rust's wire block omitted
      // a false via `skip_serializing_if`, while this side's wire block *is*
      // the stored block, so the field comes along. Inert either way — every
      // dialect reads an explicit false as no error — and stable across turns,
      // which is what the cache prefix needs.
      const expectedCached = stripHopFields(out["cached_last_request"]);

      // A turn that failed never told autonomy anything, and the Rust recorded
      // that as a null rather than an empty body.
      let cached: unknown = null;
      if (run.lastRequest !== undefined) {
        const copy = { ...(run.lastRequest as Record<string, unknown>) };
        delete copy["rid"];
        cached = copy;
      }
      expect(shaped(dropFalseIsError(cached))).toEqual(shaped(expectedCached));

      // Not fixture-driven: the Rust's autonomy manager keeps its state in a
      // file the generator would have had to read back turn by turn, and each
      // of these calls is pinned on its own elsewhere (turn_parity for the
      // first two, persistence for the last two). What is unpinned without
      // this is that the driver makes them, and in this order.
      const expectedCalls = ["ensureState"];
      const body = input(c)["body"] as Record<string, unknown>;
      const fresh =
        (c.input as Record<string, any>)["regen"] !== true &&
        ((body["text"] as string) !== "" ||
          ((body["images"] as unknown[] | undefined)?.length ?? 0) > 0);
      if (fresh) expectedCalls.push("onUserMessage");
      if ((out["result"] as Record<string, unknown>)["error"] === undefined) {
        expectedCalls.push("notifyLastRequest", "notifyAssistantMessage", "shouldCompactNow");
      }
      expect(run.autonomyCalls).toEqual(expectedCalls);

      const expectedError = (out["result"] as Record<string, unknown>)["error"];
      if (expectedError === undefined) {
        expect(run.error).toBeUndefined();
        // Not fixture-driven — see the note on `shouldCompactNow`. The gate is
        // consulted after every frame the turn sends, `stream_end` included,
        // which is what makes it safe for it to read the engine.
        expect(run.compactionCheckedAfter).toBe(run.direct.length);
        expect(run.direct.at(-1)?.type).toBe("stream_end");
      } else {
        expect(run.error).toBeDefined();
        // A turn that failed persists nothing and never reaches the gate.
        expect(run.compactionCheckedAfter).toBe(-1);
      }
    });
  }
});

// ── one turn that is not fixture-driven, and says why ───────────────────

/**
 * A sampler preference reaches the request.
 *
 * Not from the fixture: the generator handed `handle_generation` a
 * `ResolvedModel` the Rust handler had already merged, so no recorded case has
 * an overlay to carry. What both halves are is pinned —
 * `handler_active_model.test.ts` for the resolution, `setup_parity.json` for
 * the merge — and what is not is that the driver threads one into the other. A
 * dropped overlay is silent: the turn runs, on the catalog's defaults, and the
 * user's `shore model set temperature` did nothing.
 */
test("a sampler preference set for the character reaches the outgoing request", async () => {
  const root = await tempRoot("overlay");
  const config = await loadedConfig(root, { with_model: true });
  process.env[MODEL_KEY_ENV] = "fixture-key";

  await mkdir(join(config.dirs.config, "characters", "ada"), { recursive: true });
  await writeFile(join(config.dirs.config, "characters", "ada", "character.md"), "ada");
  await mkdir(join(config.dirs.data, "ada", "preferences"), { recursive: true });
  await writeFile(
    join(config.dirs.data, "ada", "preferences", "models.toml"),
    '[models."anthropic:claude-fixture"]\ntemperature = 0.25\n',
  );

  const requests: SidecarRequest[] = [];
  const answer: StreamEvent[] = [
    { type: "start", model: "claude-fixture" },
    {
      type: "done",
      content: "ok",
      finish_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    },
  ];
  const provider: SidecarProvider = {
    async *stream(req) {
      requests.push(req);
      yield* answer;
    },
    generate: () => {
      throw new Error("unused");
    },
  };

  const engine = generationEngine(
    await ConversationEngine.load("ada", config.dirs.data, undefined),
  );

  await runGeneration(
    {
      registry: { getOrCreate: async () => engine, effectiveConfig: () => config },
      dataDir: config.dirs.data,
      providers: { anthropic: provider },
      autonomy: {
        ensureState: () => false,
        backfillActivity: () => {},
        onUserMessage: () => {},
        shouldCompactNow: () => false,
        onCompactionComplete: () => {},
        onCompactionFailed: () => {},
        notifyLastRequest: () => {},
        notifyAssistantMessage: () => {},
      },
      notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
      sessionTokens: { input: 0, output: 0 } as GenerationDeps["sessionTokens"],
      diagnostics: {
        api_calls: { push: () => {} },
        tool_calls: { push: () => {} },
        key_fallbacks: { push: () => {} },
      },
      emitEvent: () => {},
      mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
      compaction: { run: async () => 0, applyDeferredEdits: async () => {} },
      newlyCrossedUsageBudgetWarnings: async () => [],
      now: () => MINTED_TS,
      newMessageId: () => `m_${crypto.randomUUID()}`,
      monotonicMs: () => 0,
      sleep: async () => {},
    },
    {
      meta: { session: { sessionId: 1 } } as never,
      body: { rid: null, text: "hello", stream: true, images: [], image_data: [] },
      regen: false,
      charName: "ada",
      rid: null,
      send: async () => {},
      signal: new AbortController().signal,
    },
  );

  expect(requests[0]?.temperature).toBe(0.25);
});

/**
 * A turn that cannot resolve a model writes nothing.
 *
 * Not from the fixture, and it could not be: the Rust appended the user turn
 * and resolved the model *after* it, so the recorded behaviour is the bug —
 * `send` into a config with no `[providers.*]` failed, and left the message in
 * `active.jsonl` with no assistant turn and nothing in the CLI output saying it
 * had been kept. Repeating the command stacked them up (#31).
 *
 * The assertion is the file, not the engine's in-memory list: the complaint was
 * about what `shore log` showed on the next run.
 */
test("a turn with no model configured leaves the conversation untouched", async () => {
  const root = await tempRoot("nomodel");
  // No `with_model`, so the catalog is empty and no default is named — the
  // shape of a fresh install that has not configured a provider yet.
  const config = await loadedConfig(root, {});
  await mkdir(join(config.dirs.data, "ada"), { recursive: true });

  const engine = generationEngine(
    await ConversationEngine.load("ada", config.dirs.data, undefined),
  );
  const broadcast: ServerMessage[] = [];
  const direct: ServerMessage[] = [];

  const run = runGeneration(
    {
      registry: { getOrCreate: async () => engine, effectiveConfig: () => config },
      dataDir: config.dirs.data,
      providers: {
        anthropic: {
          stream: () => {
            throw new Error("a turn with no model must not reach a provider");
          },
          generate: () => {
            throw new Error("a turn with no model must not reach a provider");
          },
        },
      },
      autonomy: {
        ensureState: () => false,
        backfillActivity: () => {},
        onUserMessage: () => {},
        shouldCompactNow: () => false,
        onCompactionComplete: () => {},
        onCompactionFailed: () => {},
        notifyLastRequest: () => {},
        notifyAssistantMessage: () => {},
      },
      notifier: { notifyMessageComplete: () => {} } as unknown as GenerationDeps["notifier"],
      sessionTokens: { input: 0, output: 0 } as GenerationDeps["sessionTokens"],
      diagnostics: {
        api_calls: { push: () => {} },
        tool_calls: { push: () => {} },
        key_fallbacks: { push: () => {} },
      },
      emitEvent: (m) => broadcast.push(m),
      mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
      compaction: { run: async () => 0, applyDeferredEdits: async () => {} },
      newlyCrossedUsageBudgetWarnings: async () => [],
      now: () => MINTED_TS,
      newMessageId: () => `m_${crypto.randomUUID()}`,
      monotonicMs: () => 0,
      sleep: async () => {},
    },
    {
      meta: { session: { sessionId: 1 } } as never,
      body: { rid: null, text: "hello", stream: true, images: [], image_data: [] },
      regen: false,
      charName: "ada",
      rid: null,
      send: async (m) => {
        direct.push(m);
      },
      signal: new AbortController().signal,
    },
  );

  await expect(run).rejects.toThrow(NO_CHAT_MODELS_MESSAGE);

  expect(existsSync(characterActiveJsonl(config.dirs.data, "ada"))).toBe(false);
  expect(engine.messages()).toEqual([]);
  // And the turn was never announced: a `new_message` for a message that was
  // not kept is the same lie from the other direction.
  expect(broadcast).toEqual([]);
  expect(direct).toEqual([]);
});
