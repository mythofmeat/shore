import type { McpRegistry } from "./mcp_registry.ts";

export class McpHolder {
  #registry: McpRegistry;

  constructor(registry: McpRegistry) {
    this.#registry = registry;
  }

  get current(): McpRegistry {
    return this.#registry;
  }

  replace(next: McpRegistry): McpRegistry {
    const previous = this.#registry;
    this.#registry = next;
    return previous;
  }

  callView(): Pick<McpRegistry, "call"> {
    return { call: (fullName, args) => this.#registry.call(fullName, args) };
  }
}
