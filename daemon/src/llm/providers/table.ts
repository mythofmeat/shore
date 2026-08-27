import type { SidecarProvider, SidecarRequest } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import { OpenAIProvider } from "./openai.ts";
import { VercelProvider } from "./vercel.ts";
import { ZaiProvider } from "./zai.ts";

const vercel = new VercelProvider();

export const DEFAULT_PROVIDERS: Partial<Record<SidecarRequest["sdk"], SidecarProvider>> = {
  anthropic: new AnthropicProvider(),
  gemini: new GeminiProvider(),
  openrouter: vercel,
  openai: new OpenAIProvider(),
  zai: new ZaiProvider(),
  deepseek: vercel,
  moonshot: vercel,
};
