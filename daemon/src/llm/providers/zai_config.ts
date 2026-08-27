export const ZAI_API_PROVIDER = "zai-api";
export const ZAI_SUB_PROVIDER = "zai-sub";

export const ZAI_API_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_SUB_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

export const ZAI_SUBSCRIPTION_SETTING_MIGRATION =
  "`zai_subscription` was removed; select `zai-sub:<model_id>` for Coding Plan traffic " +
  "or `zai-api:<model_id>` for pay-as-you-go traffic";

export function zaiBaseUrl(providerKey: string): string {
  return providerKey === ZAI_SUB_PROVIDER ? ZAI_SUB_BASE_URL : ZAI_API_BASE_URL;
}

export function isZaiProvider(providerKey: string): boolean {
  return providerKey === ZAI_API_PROVIDER || providerKey === ZAI_SUB_PROVIDER;
}
