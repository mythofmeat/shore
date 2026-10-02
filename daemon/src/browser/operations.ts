import type { OperationInput, OperationName, OperationResult } from "../operations/types.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { RequestFinished } from "../protocol/RequestFinished.ts";
import type { BrowserConnection } from "./connection.ts";
import { validOperationInput, validOperationResult } from "./operation_validators.generated.js";

export class OperationFailure extends Error {
  constructor(readonly operation: OperationName, readonly completion: RequestFinished) {
    super(completion.error?.message ?? `Action ${completion.outcome}`);
    this.name = "OperationFailure";
  }
}

export class OperationClient {
  #requests = new Map<string, OperationName>();
  pendingOperation(rid: string | null | undefined): OperationName | undefined { return rid === undefined || rid === null ? undefined : this.#requests.get(rid); }
  constructor(readonly connection: BrowserConnection) {}

  async run<N extends OperationName>(name: N, input: OperationInput<N>, options: { observe?: (message: ServerMessage) => void } = {}): Promise<OperationResult<N>> {
    if (!validOperationInput(name, input)) throw new Error(`Invalid arguments for ${name}`);
    let rid: string | undefined;
    let result: unknown;
    const images = new Map<string, string>();
    let received = false;
    let invalid = false;
    const unsubscribe = this.connection.subscribe((update) => {
      if (update.kind !== "frame" || !("rid" in update.message) || update.message.rid !== rid) return;
      options.observe?.(update.message);
      if (name === "run_tool") {
        const message = update.message;
        if (message.type === "send_image" && typeof message.data === "string") images.set(message.path, message.data);
        if (message.type === "tool_result") for (const image of message.images ?? []) if (typeof image.data === "string" && !images.has(image.path)) images.set(image.path, image.data);
      }
      if (update.message.type !== "command_output") return;
      if (received || update.message.name !== name) invalid = true;
      received = true;
      result = update.message.data;
    });
    try {
      const ticket = this.connection.submit({ type: "command", name, args: input });
      rid = ticket.rid;
      this.#requests.set(rid, name);
      const completion = await ticket.finished;
      if (completion.outcome !== "completed") throw new OperationFailure(name, completion);
      if (name === "run_tool" && validOperationResult("run_tool", result) && !("mode" in result) && result.images !== undefined) {
        result = { ...result, images: result.images.map(image => ({ ...image, data: image.data ?? images.get(image.path) ?? null })) };
      }
      if (invalid || !received || !validOperationResult(name, result)) throw new Error(`Invalid result for ${name}`);
      return result;
    } finally { if (rid !== undefined) this.#requests.delete(rid); unsubscribe(); }
  }
}
