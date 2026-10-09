import { createInterface } from "node:readline";

import { NotImplemented } from "./errors.ts";
import { encodeError, isWorkspaceOp, WORKSPACE_OPS } from "./workspace_ops.ts";

export type HelperRequest =
  | { id: number; op: string; args: unknown }
  | { cancel: number };

export type HelperReply =
  | { id: number; result?: unknown }
  | { id: number; error: ReturnType<typeof encodeError> };

export async function serveWorkspaceHelper(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const controllers = new Map<number, AbortController>();
  const running = new Set<Promise<void>>();
  const send = (reply: HelperReply): void => {
    output.write(`${JSON.stringify(reply)}\n`);
  };
  const run = async (id: number, op: string, args: unknown, signal: AbortSignal): Promise<void> => {
    try {
      if (!isWorkspaceOp(op)) throw new NotImplemented(op);
      const call = WORKSPACE_OPS[op] as (args: unknown, signal: AbortSignal) => Promise<unknown>;
      send({ id, result: await call(args, signal) });
    } catch (error) {
      send({ id, error: encodeError(error) });
    } finally {
      controllers.delete(id);
    }
  };
  for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (line.trim() === "") continue;
    const request = JSON.parse(line) as HelperRequest;
    if ("cancel" in request) {
      controllers.get(request.cancel)?.abort();
      continue;
    }
    const controller = new AbortController();
    controllers.set(request.id, controller);
    const task = run(request.id, request.op, request.args, controller.signal);
    running.add(task);
    void task.finally(() => running.delete(task));
  }
  for (const controller of controllers.values()) controller.abort();
  await Promise.all(running);
}
