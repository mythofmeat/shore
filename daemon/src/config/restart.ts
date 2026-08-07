/**
 * Which parts of a reloaded config a running daemon cannot pick up.
 *
 * Ported from `restart_required_changes` in `crates/daemon/src/handler/mod.rs`.
 *
 * Almost everything in the config is read per-turn, so a reload takes effect on
 * the next message. These five are read exactly once, while the process is
 * starting: `[daemon]` becomes the bound listener, `[notifications]` becomes the
 * notifier that every task was handed, `[advanced].llm_sidecar` decides whether
 * a sidecar was launched and on which socket, and the two `[advanced]` logging
 * switches decide which writers were opened. Adopting a new value for any of
 * them changes the config the daemon reports while changing nothing it does.
 *
 * So the reload still happens — that is the point of the annotation rather than
 * a refusal — and the client is told which sections it will not see move. A
 * `config_reload` puts this list in `restart_required`; the hot-reload watcher
 * logs it.
 */

import type { LoadedConfig } from "./loader.ts";
import { serializeConfigValue } from "./serialize.ts";

/**
 * The startup-owned sections that differ between two configs, named as the
 * client prints them.
 *
 * Empty means the reload is complete: everything that changed is live.
 */
export function restartRequiredChanges(old: LoadedConfig, fresh: LoadedConfig): string[] {
  const a = old.app;
  const b = fresh.app;
  const changes: string[] = [];
  if (!same(a.daemon, b.daemon)) changes.push("[daemon]");
  if (!same(a.notifications, b.notifications)) changes.push("[notifications]");
  if (a.advanced.api_payload_logging !== b.advanced.api_payload_logging) {
    changes.push("[advanced].api_payload_logging");
  }
  if (a.advanced.cache_forensics !== b.advanced.cache_forensics) {
    changes.push("[advanced].cache_forensics");
  }
  if (!same(a.advanced.llm_sidecar, b.advanced.llm_sidecar)) {
    changes.push("[advanced].llm_sidecar");
  }
  return changes;
}

/**
 * `PartialEq` for a config section.
 *
 * The sections hold `ConfigDuration`s, which are objects and so never `===`
 * even when they mean the same length of time. {@link serializeConfigValue}
 * already renders one as its canonical string — it is how the `config` command
 * puts these same structs on the wire — so comparing the serialised forms costs
 * one walk and inherits every rule that surface already has to get right.
 *
 * The walk below is structural rather than a `JSON.stringify` comparison
 * because key order would otherwise be part of the answer. It is stable today,
 * since both configs come out of the same field-by-field builders, but nothing
 * says it has to stay that way.
 *
 * For the same reason, the key-*count* check in `equal` cannot be observed
 * through this function and no test can kill a mutant that drops it: `readStruct`
 * builds every section from its defaults and rejects any field it does not know,
 * none of these three sections holds a map, and a `None` serialises to `null`
 * rather than to an absent key. So both sides always have identical key sets. It
 * stays because `equal` is a general comparison and being right about one input
 * shape is not the same as being right.
 */
function same(a: unknown, b: unknown): boolean {
  return equal(serializeConfigValue(a), serializeConfigValue(b));
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((k) => Object.hasOwn(right, k) && equal(left[k], right[k]))
  );
}
