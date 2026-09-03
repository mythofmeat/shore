export const NANOGPT_PROVIDER = "nanogpt";

export const NANOGPT_BASE_URL = "https://nano-gpt.com/api/v1";

export const NANOGPT_SUBSCRIPTION_BASE_URL = "https://nano-gpt.com/api/subscription/v1";

export const NANOGPT_PAID_BASE_URL = "https://nano-gpt.com/api/paid/v1";

export const NANOGPT_MODELS_QUERY = "?detailed=true";

export const NANOGPT_MODELS_URL = `${NANOGPT_BASE_URL}/models${NANOGPT_MODELS_QUERY}`;

export const NANOGPT_SUBSCRIPTION_MODELS_URL =
  `${NANOGPT_SUBSCRIPTION_BASE_URL}/models${NANOGPT_MODELS_QUERY}`;

export const NANOGPT_PAID_MODELS_URL = `${NANOGPT_PAID_BASE_URL}/models${NANOGPT_MODELS_QUERY}`;

export const NANOGPT_USAGE_URL = `${NANOGPT_SUBSCRIPTION_BASE_URL}/usage`;

export function isNanoGptProvider(providerKey: string): boolean {
  return providerKey === NANOGPT_PROVIDER;
}
