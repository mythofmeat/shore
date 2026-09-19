import type { SamplerSettings } from "../config/preferences.ts";
import type { DiscoveredModelSupport } from "../llm/discovery.ts";
import {
  SAMPLER_KEYS,
  applySamplerValue as applyRegistryValue,
  settingSchema,
  validateSetting,
} from "../llm/settings.ts";
import type { Sdk } from "../llm/types.ts";
import { invalidRequest, type CommandError } from "./errors.ts";

export { SAMPLER_KEYS, settingSchema };

export function applySamplerValue(sampler: SamplerSettings, key: string, value: unknown): void {
  try {
    applyRegistryValue(sampler, key, value);
  } catch (error) {
    throw invalidRequest(error instanceof Error ? error.message : String(error));
  }
}

export function capabilityCheck(
  sdk: Sdk,
  key: string,
  value: unknown,
  support?: DiscoveredModelSupport,
  modelId?: string,
): CommandError | undefined {
  const failure = validateSetting(sdk, key, value, support, modelId);
  return failure === undefined ? undefined : invalidRequest(failure);
}
