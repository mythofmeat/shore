/**
 * The one place that says which `McpRegistry` is current.
 *
 * `ShoreRuntime.mcp` used to be a plain readonly field, captured by value in
 * four places — a chat turn's tool deps, the same call inside
 * `InProcessAutonomyExecutor`, the compaction runners, and the keepalive's
 * rebuild deps. That is why reloading `[mcp]` did nothing until the daemon
 * restarted (#28): there was no way to swap the registry that did not leave
 * some of those copies pointing at the old one.
 *
 * **And a partial swap is worse than none.** If chat picked up a new registry
 * and the heartbeat kept the old one, the two would offer different tool
 * surfaces — tool definitions sit ahead of `system` in the cached prefix, so a
 * background tick would write a prefix the next chat turn could not reuse.
 * Silently, on every turn, until a restart. That is a 0.1× read becoming a 2.0×
 * write, which is the failure `runtime.ts`'s assembly order exists to prevent
 * and the one #33's fourth cold trigger now labels.
 *
 * So there is one holder and everything reads through it.
 */

import type { McpRegistry } from "./mcp_registry.ts";

export class McpHolder {
  #registry: McpRegistry;

  constructor(registry: McpRegistry) {
    this.#registry = registry;
  }

  /** The registry every consumer should be reading *now*. */
  get current(): McpRegistry {
    return this.#registry;
  }

  /**
   * Adopt a new registry and hand back the one it replaced, for the caller to
   * shut down.
   *
   * The old registry is returned rather than shut down here, because the order
   * matters and belongs to the caller: swap first so nothing can take another
   * reference to the old one, *then* close its transports.
   */
  replace(next: McpRegistry): McpRegistry {
    const previous = this.#registry;
    this.#registry = next;
    return previous;
  }

  /**
   * A live view for a consumer that only calls tools.
   *
   * The distinction that makes this worth having: a turn's tool *definitions*
   * are computed once, in `buildGenerationRequest`, and reused for every round
   * of its loop — so the surface a turn advertises cannot change underneath it
   * and its cache prefix is stable whatever a reload does. Dispatch is the only
   * thing that should follow the swap, and this is what lets it.
   *
   * Without it, a turn holding the replaced registry would find every remaining
   * MCP call dead once its transports closed — not one call, the rest of the
   * turn. With it, tools that still exist keep working and tools that genuinely
   * went away report exactly that, through the registry's ordinary
   * "not yet implemented". A call already on the wire when the swap lands still
   * fails; nothing can prevent that one.
   */
  callView(): Pick<McpRegistry, "call"> {
    return { call: (fullName, args) => this.#registry.call(fullName, args) };
  }
}
