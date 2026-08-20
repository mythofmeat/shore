import { shoreLog } from "../log.ts";

import type { Sdk } from "./types.ts";

const RESPECTS_INLINE_HINTS: ReadonlySet<Sdk> = new Set<Sdk>(["anthropic"]);

const EXTENDED_TTL_HOSTS: readonly string[] = ["api.anthropic.com"];

const EXTENDED_TTL_HOST_SUFFIXES: readonly string[] = ["-aiplatform.googleapis.com"];

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLocalRelay(host: string): boolean {
  const hostname = host.replace(/:\d+$/, "");
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export function respectsInlineCacheHints(sdk: Sdk): boolean {
  return RESPECTS_INLINE_HINTS.has(sdk);
}

export function hostOfBaseUrl(baseUrl: string | undefined): string {
  try {
    return new URL(baseUrl === undefined || baseUrl === "" ? DEFAULT_ANTHROPIC_BASE_URL : baseUrl)
      .host;
  } catch {
    return "";
  }
}

export function supportsExtendedCacheTtl(baseUrl: string | undefined): boolean {
  const host = hostOfBaseUrl(baseUrl);
  if (EXTENDED_TTL_HOSTS.includes(host)) return true;
  if (isLocalRelay(host)) return true;
  return EXTENDED_TTL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function effectiveCacheTtl(
  sdk: Sdk,
  baseUrl: string | undefined,
  requested: string,
): string {
  if (requested === "") return "";
  if (!respectsInlineCacheHints(sdk)) {
    shoreLog.warn(
      `shore: cache_ttl=${requested} was requested for sdk ${sdk}, which does not read inline ` +
        `cache_control markers; no marker is being sent`,
    );
    return "";
  }
  if (requested === "1h" && !supportsExtendedCacheTtl(baseUrl)) {
    shoreLog.warn(
      `shore: cache_ttl=1h is only honoured by api.anthropic.com and the Vertex endpoints; ` +
        `${hostOfBaseUrl(baseUrl)} gets the default 5-minute marker instead`,
    );
    return "5m";
  }
  return requested;
}
