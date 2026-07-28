/**
 * Calling back into the daemon to run a tool.
 *
 * The sidecar drives the tool loop but cannot execute the tools: the executors
 * live in the daemon, holding the filesystem, the memory store, MCP, and
 * sub-agents. Each tool the model asks for becomes one call over the daemon's
 * tool socket.
 *
 * Protocol (mirrors `crates/daemon/src/tool_rpc.rs`): line-delimited JSON over
 * a Unix socket, one connection per call. Write a request and a newline, read
 * an answer and a newline, close. A connection *is* the correlation, so there
 * is no framing, keep-alive, or request id.
 *
 * # Two kinds of failure, deliberately not the same
 *
 * A tool that ran and failed is a **result**: the model is told and decides
 * what to do next. Those come back as `{output, is_error: true}` and are
 * rethrown as `ToolError`, which the runner turns into a `tool_result` with
 * `is_error` set and the daemon's own text preserved.
 *
 * A call that never reached a loop — no such rid, the loop stopped, the socket
 * is gone — is a **transport error**. Feeding that to the model as a tool
 * failure would describe a plumbing problem as something the model did, so the
 * turn is abandoned instead.
 *
 * Abandoning has to be done by aborting, not by throwing: the runner catches
 * everything a tool throws and formats it as tool-result content, so there is
 * no throwable value that ends a turn. `onUnreachable` aborts the runner's
 * signal; the subsequent throw only unwinds this call.
 */

import { ToolError } from "@anthropic-ai/sdk/resources/beta/messages";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import type { ToolDefinition, ToolRpc } from "./types.ts";

/** One tool the model asked for, as the daemon expects it. */
export interface ToolCallRequest {
  rid: string;
  tool_id: string;
  name: string;
  input: unknown;
}

/** A tool that ran. `is_error` means it failed, not that the call failed. */
export interface ToolCallResponse {
  output: string;
  is_error: boolean;
}

/** The daemon could not attempt the call at all. */
export interface ToolCallError {
  error: string;
}

type ToolCallOutcome = ToolCallResponse | ToolCallError;

const isTransportError = (outcome: ToolCallOutcome): outcome is ToolCallError =>
  "error" in outcome;

/** Raised when the daemon could not attempt a call. Never reaches the model. */
export class ToolRpcUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRpcUnreachable";
  }
}

/**
 * Make one call over the tool socket.
 *
 * Resolves with whatever the daemon answered — including a tool that failed.
 * Rejects only when no answer arrived: the socket refused, the connection
 * closed first, the answer was not JSON, or the caller aborted.
 */
export async function callDaemonTool(
  socketPath: string,
  request: ToolCallRequest,
  signal?: AbortSignal | null,
): Promise<ToolCallOutcome> {
  if (signal?.aborted) {
    throw new ToolRpcUnreachable("cancelled before the tool call was sent");
  }

  return await new Promise<ToolCallOutcome>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let close: (() => void) | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      close?.();
      fn();
    };
    const onAbort = () => {
      finish(() => reject(new ToolRpcUnreachable("cancelled mid tool call")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          close = () => socket.end();
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(_socket, chunk) {
          buffer += new TextDecoder().decode(chunk);
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          const line = buffer.slice(0, newline);
          finish(() => {
            try {
              resolve(JSON.parse(line) as ToolCallOutcome);
            } catch (cause) {
              reject(
                new ToolRpcUnreachable(
                  `daemon answered with something that is not JSON: ${String(cause)}`,
                ),
              );
            }
          });
        },
        error(_socket, error) {
          finish(() => reject(new ToolRpcUnreachable(String(error))));
        },
        close() {
          // Only reached before an answer — the success path settles first.
          finish(() =>
            reject(new ToolRpcUnreachable("daemon closed the socket before answering")),
          );
        },
      },
    }).catch((cause: unknown) => {
      finish(() =>
        reject(new ToolRpcUnreachable(`cannot reach the daemon tool socket: ${String(cause)}`)),
      );
    });
  });
}

/**
 * Turn the daemon's tool surface into tools the runner can execute.
 *
 * The schemas arrive from the daemon at runtime, so the const-generic inference
 * `betaTool` normally provides does not apply — `run` receives its arguments
 * untyped and forwards them verbatim. Nothing here inspects a tool's input;
 * the daemon owns what a tool means.
 *
 * `onUnreachable` fires when the daemon could not attempt a call. See the
 * module doc: aborting is the only way to end a turn from inside a tool.
 */
export function daemonTools(
  definitions: readonly ToolDefinition[],
  rpc: ToolRpc,
  onUnreachable: (error: ToolRpcUnreachable) => void,
): BetaRunnableTool[] {
  return definitions.map((definition) =>
    betaTool({
      name: definition.name,
      description: definition.description,
      // `betaTool` wants a *literal* schema so it can derive the argument type;
      // ours arrives at runtime. Narrowing the cast to "some object schema"
      // rather than `never` keeps the derived argument type permissive — with
      // `never`, the resulting tool will not widen to the runner's tool list.
      inputSchema: definition.input_schema as { type: "object" },
      run: async (input: unknown, context) => {
        const outcome = await callDaemonTool(
          rpc.socket_path,
          {
            rid: rpc.rid,
            // The runner hands back the tool_use that triggered this run; its
            // id is what the daemon echoes into the result block.
            tool_id: context?.toolUse.id ?? "",
            name: definition.name,
            input,
          },
          context?.signal,
        ).catch((cause: unknown) => {
          const error =
            cause instanceof ToolRpcUnreachable ? cause : new ToolRpcUnreachable(String(cause));
          onUnreachable(error);
          throw error;
        });

        if (isTransportError(outcome)) {
          const error = new ToolRpcUnreachable(outcome.error);
          onUnreachable(error);
          throw error;
        }
        // A failed tool keeps the daemon's own text: ToolError carries content
        // verbatim, where a plain Error would be reformatted as "Error: …".
        if (outcome.is_error) throw new ToolError(outcome.output);
        return outcome.output;
      },
    }),
  );
}
