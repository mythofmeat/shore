/**
 * The adapter table: one entry per dialect, chosen by the request's `sdk`.
 *
 * `openrouter` is the normalized path for non-Anthropic providers (DeepSeek,
 * Kimi, GLM, MiniMax, GPT via OpenRouter). `openai`/`zai` are kept for DIRECT
 * vendor access — native OpenAI, and Z.ai's coding-subscription base URLs —
 * which OpenRouter can't serve. `deepseek`/`moonshot` are DIRECT native access
 * via the Vercel AI SDK providers (#164), which expose vendor reasoning
 * controls (thinking on/off + effort/budget). Anthropic and Gemini keep their
 * native SDKs.
 *
 * Lived in `server.ts` until that file's `/v1/*` endpoints were deleted with
 * the process boundary. It is the one thing in there the daemon still needed,
 * and it never belonged to the HTTP server: `run.ts` passes it to
 * `createRuntime`, which is the only caller.
 */

import type { SidecarProvider, SidecarRequest } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import { OpenAIProvider } from "./openai.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import { VercelProvider } from "./vercel.ts";
import { ZaiProvider } from "./zai.ts";

/** One instance, shared: `deepseek` and `moonshot` differ only by factory. */
const vercel = new VercelProvider();

export const DEFAULT_PROVIDERS: Partial<Record<SidecarRequest["sdk"], SidecarProvider>> = {
  anthropic: new AnthropicProvider(),
  gemini: new GeminiProvider(),
  openrouter: new OpenRouterProvider(),
  openai: new OpenAIProvider(),
  zai: new ZaiProvider(),
  deepseek: vercel,
  moonshot: vercel,
};
