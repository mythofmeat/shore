import { query } from "@anthropic-ai/claude-agent-sdk";

import type { SidecarProvider, SidecarRequest } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { ClaudeAgentProvider } from "./claude_agent.ts";
import { GeminiProvider } from "./gemini.ts";
import { OpenAIProvider } from "./openai.ts";
import { VercelProvider } from "./vercel.ts";
import { ZaiProvider } from "./zai.ts";

const vercel = new VercelProvider();
const openai = new OpenAIProvider();

export const DEFAULT_PROVIDERS: Partial<Record<SidecarRequest["sdk"], SidecarProvider>> = {
  anthropic: new AnthropicProvider(),
  claude_agent: new ClaudeAgentProvider({ planQuery: query }),
  gemini: new GeminiProvider(),
  openrouter: vercel,
  openai,
  zai: new ZaiProvider(),
  deepseek: vercel,
  moonshot: vercel,
  nanogpt: openai,
};
