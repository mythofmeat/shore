import type { SidecarRequest } from "./types.ts";

export const REDACTED = "[redacted]";

const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "x-api-token",
  "x-goog-api-key",
  "x-goog-iam-authorization-token",
  "openai-api-key",
  "cookie",
  "set-cookie",
]);

export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.toLowerCase());
}

export function redactHeaders(pairs: readonly [string, string][]): [string, string][] {
  return pairs.map(([name, value]) =>
    isCredentialHeader(name) ? [name, REDACTED] : [name, value],
  );
}

export function redactRequest(req: SidecarRequest): SidecarRequest {
  return req.api_key === "" ? req : { ...req, api_key: REDACTED };
}
