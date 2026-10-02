import Anthropic from "@anthropic-ai/sdk";

import type { SidecarRequest } from "../types.ts";

function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

export function anthropicClientFor(req: SidecarRequest): Anthropic {
  return new Anthropic({
    apiKey: req.api_key,
    maxRetries: 0,
    ...(req.base_url ? { baseURL: stripTrailingV1(req.base_url) } : {}),
  });
}
