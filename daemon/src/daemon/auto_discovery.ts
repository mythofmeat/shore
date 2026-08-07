/**
 * Keeping each provider's model list from going stale.
 *
 * Ported from `crates/daemon/src/auto_discovery.rs`.
 *
 * A pass at boot and every {@link REFRESH_INTERVAL_MS} after it. Each provider
 * that is enabled *and* has `discovery.enabled` is refreshed if its on-disk
 * cache is missing or past its TTL. `refreshOne` does the work; this decides
 * who and when.
 *
 * # Failures are per provider and never propagate
 *
 * A transient outage at one provider must not stop the daemon, and must not
 * stop the other providers being refreshed. `writeCache` is atomic, so a fetch
 * that fails or returns something unparseable leaves the previous cache exactly
 * where it was — a stale list is worth much more than no list.
 *
 * # One divergence: the config is read live
 *
 * The Rust captured a `LoadedConfig` when the loop was spawned, so enabling a
 * provider — or turning its discovery on — did nothing until the daemon was
 * restarted. That was true of everything on the reload path before
 * `hot_reload.ts` landed. This reads through the registry per pass, so a
 * provider added to `config.toml` is discovered on the next tick.
 */

import type { LoadedConfig } from "../config/loader.ts";
import { refreshOne } from "../commands/providers.ts";
import { cachePath, isStale, readCache, REFRESH_INTERVAL_MS } from "../llm/discovery.ts";

export interface AutoDiscoveryOptions {
  /** Read per pass, not held — see the module doc. */
  readonly config: () => LoadedConfig;
  /** How often to look. Small in tests; {@link REFRESH_INTERVAL_MS} live. */
  readonly intervalMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    warn?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

/**
 * Start the loop. The first pass runs immediately, as the Rust's `interval`
 * did — a daemon restarted after a long gap should not wait a day for a list
 * it already knows is stale.
 */
export function startAutoDiscovery(options: AutoDiscoveryOptions): { stop: () => void } {
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS;
  // A pass that overran its interval must not have a second one start beside
  // it: both would fetch, and both would write the same cache file.
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
    // `clearInterval` is the whole of it. There is no second latch, because
    // there is nothing for one to catch: `pass` is only ever reached from the
    // timer or from the line above, and a pass already in flight has already
    // made its requests. A stopped loop starts nothing new; it does not
    // abandon what it started.
    stop: () => {
      clearInterval(timer);
      options.log?.info?.("Auto-discovery loop stopped");
    },
  };
}

/** One sweep over every configured provider. */
export async function refreshPass(options: AutoDiscoveryOptions): Promise<void> {
  const config = options.config();
  const cacheDir = config.dirs.cache;

  for (const [name, entry] of config.providers.entries()) {
    if (!entry.enabled || !entry.discovery.enabled) continue;

    // A cache that is present and inside its TTL is left alone. Without this
    // the loop would refetch every provider on every restart, which for a
    // daemon that restarts often is a request per provider per restart and
    // nothing gained.
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
      // Warned and skipped. The previous cache stands, which is the whole
      // reason `writeCache` is atomic.
      options.log?.warn?.("Auto-refresh failed; previous cache preserved", {
        provider: name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
