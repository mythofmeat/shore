import type { OperationInput, OperationName, OperationResult } from "../operations/types.ts";
import type { RequestFinished } from "../protocol/RequestFinished.ts";
import type { BrowserConnection } from "./connection.ts";
import { isOperationName, validOperationInput, validOperationResult } from "./operation_validators.generated.js";

export class OperationFailure extends Error {
  constructor(readonly operation: OperationName, readonly completion: RequestFinished) {
    super(completion.error?.message ?? `Action ${completion.outcome}`);
    this.name = "OperationFailure";
  }
}

export class OperationClient {
  constructor(readonly connection: BrowserConnection) {}

  async runDiscovered(name: string, input: unknown): Promise<OperationResult<OperationName>> {
    if (!isOperationName(name) || !validOperationInput(name, input)) throw new Error(`Invalid arguments for ${name}`);
    return this.run(name, input);
  }

  async run<N extends OperationName>(name: N, input: OperationInput<N>): Promise<OperationResult<N>> {
    if (!validOperationInput(name, input)) throw new Error(`Invalid arguments for ${name}`);
    let rid: string | undefined;
    let result: unknown;
    let received = false;
    let invalid = false;
    const unsubscribe = this.connection.subscribe((update) => {
      if (update.kind !== "frame" || update.message.type !== "command_output" || update.message.rid !== rid) return;
      if (received || update.message.name !== name) invalid = true;
      received = true;
      result = update.message.data;
    });
    try {
      const ticket = this.connection.submit({ type: "command", name, args: input });
      rid = ticket.rid;
      const completion = await ticket.finished;
      if (completion.outcome !== "completed") throw new OperationFailure(name, completion);
      if (invalid || !received || !validOperationResult(name, result)) throw new Error(`Invalid result for ${name}`);
      return result;
    } finally { unsubscribe(); }
  }
}
