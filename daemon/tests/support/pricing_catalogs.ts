import { NANOGPT_MODELS_URL } from "../../src/llm/providers/nanogpt_config.ts";

const CATALOGS = new Set(["https://openrouter.ai/api/v1/models", NANOGPT_MODELS_URL]);

export function answerPricingCatalogsWithNoModels(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      CATALOGS.has(input instanceof Request ? input.url : input.toString())
        ? Promise.resolve(Response.json({ data: [] }))
        : realFetch(input, init),
    realFetch,
  );
}
