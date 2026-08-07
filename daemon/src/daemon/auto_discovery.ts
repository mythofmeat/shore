import type { LoadedConfig } from "../config/loader.ts";
import { refreshOne } from "../commands/providers.ts";
import { cachePath, isStale, readCache, REFRESH_INTERVAL_MS } from "../llm/discovery.ts";

export interface AutoDiscoveryOptions {
  readonly config: () => LoadedConfig;
  readonly intervalMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    warn?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export function startAutoDiscovery(options: AutoDiscoveryOptions): { stop: () => void } {
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS;
  let running = false;

  const pass = () => {
    if (running) return;
    running = true;
    void refreshPass(options)
      .catch((e: unknown) => {
        options.log?.warn?.("Auto-discovery pass failed", { error: String(e) });
      })
      .finally(() => {
        running = false;
      });
  };

  options.log?.info?.("Auto-discovery loop started", { interval_ms: intervalMs });
  pass();
  const timer = setInterval(pass, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
      options.log?.info?.("Auto-discovery loop stopped");
    },
  };
}

export async function refreshPass(options: AutoDiscoveryOptions): Promise<void> {
  const config = options.config();
  const cacheDir = config.dirs.cache;

  for (const [name, entry] of config.providers.entries()) {
    if (!entry.enabled || !entry.discovery.enabled) continue;

    const cache = await readCache(cachePath(cacheDir, name));
    if (cache !== undefined && !isStale(cache)) continue;

    try {
      const outcome = await refreshOne(
        config,
        cacheDir,
        name,
        ...(options.fetchImpl === undefined ? [] : [options.fetchImpl]),
      );
      options.log?.info?.("Auto-refreshed provider models", {
        provider: name,
        models: outcome.cache.models.length,
      });
    } catch (e) {
      options.log?.warn?.("Auto-refresh failed; previous cache preserved", {
        provider: name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
