import { deriveContentFromBlocks } from "../engine/message_store.ts";
import type { ContentBlock, ImageRef, Message, Role } from "../engine/types.ts";
import { imageDataForPath } from "../engine/wire_images.ts";
import type { ToolUseEvent } from "../engine/tool_loop.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import {
  dispatchWithinDeadline,
  resultCharsFor,
  timeoutFor,
  windowToolResult,
  type ToolContext,
  type ToolLimitsView,
  type ToolResultWindow,
} from "./dispatch.ts";
import { schemaViolation, type ToolSchemas } from "./validate.ts";

export interface ToolExecution {
  sendDirect: (message: ServerMessage) => void;
  ctx: ToolContext;
  limits: ToolLimitsView;
  rid?: string;
  subagent?: string;
  now: () => string;
  newMessageId: () => string;
  monotonicMs?: () => number;
  schemas?: ToolSchemas;
}

export interface ToolRun {
  block: ContentBlock;
  raw: string;
  isError: boolean;
  rejected: boolean;
  durationMs: number;
  window?: ToolResultWindow;
}

export async function executeToolUse(
  toolUse: ToolUseEvent,
  exec: ToolExecution,
  intermediateMessages: Message[],
): Promise<ContentBlock> {
  return (await runToolUse(toolUse, exec, intermediateMessages)).block;
}

export async function runToolUse(
  toolUse: ToolUseEvent,
  exec: ToolExecution,
  intermediateMessages: Message[],
): Promise<ToolRun> {
  exec.sendDirect({
    type: "tool_call",
    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
    tool_id: toolUse.id,
    tool_name: toolUse.name,
    input: toolUse.input,
  });

  const clock = exec.monotonicMs ?? Date.now;
  const startedAt = clock();

  const rejection = argumentRejection(toolUse, exec.schemas);
  if (rejection !== undefined) {
    console.warn(`shore: rejected a ${toolUse.name} call — ${rejection}`);
    const rejectedMs = clock() - startedAt;
    emitToolResult(exec, toolUse, rejection, true);
    return {
      block: { type: "tool_result", tool_use_id: toolUse.id, content: rejection, is_error: true },
      raw: rejection,
      isError: true,
      rejected: true,
      durationMs: rejectedMs,
    };
  }

  let rawOutput: string;
  let isError: boolean;
  let okValue: unknown;
  try {
    const value = await dispatchWithinDeadline(
      toolUse.name,
      toolUse.input,
      { ...exec.ctx, toolUseId: toolUse.id },
      timeoutFor(exec.limits, toolUse.name),
    );
    rawOutput = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    isError = false;
    okValue = value;
  } catch (e) {
    rawOutput = e instanceof Error ? e.message : String(e);
    isError = true;
  }
  const dispatchMs = clock() - startedAt;

  const windowed = windowToolResult(rawOutput, resultCharsFor(exec.limits, toolUse.name));
  const output = windowed.output;

  if (!isError && toolUse.name === "generate_image") {
    attachGeneratedImage(okValue, intermediateMessages, exec);
  }

  emitToolResult(exec, toolUse, output, isError);

  return {
    block: { type: "tool_result", tool_use_id: toolUse.id, content: output, is_error: isError },
    raw: rawOutput,
    isError,
    rejected: false,
    durationMs: dispatchMs,
    window: windowed,
  };
}

export function argumentRejection(
  toolUse: ToolUseEvent,
  schemas: ToolSchemas | undefined,
): string | undefined {
  const reason =
    toolUse.input_error ?? schemaViolation(schemas?.get(toolUse.name), toolUse.input);
  if (reason === undefined) return undefined;
  return (
    `The call to ${toolUse.name} was not run because ${reason}. ` +
    `Nothing was executed and no state changed. Issue the call again with complete, ` +
    `well-formed arguments.`
  );
}

export function attachGeneratedImage(
  value: unknown,
  intermediateMessages: Message[],
  exec: Pick<ToolExecution, "sendDirect" | "rid">,
): void {
  if (typeof value !== "object" || value === null) return;
  const fields = value as Record<string, unknown>;
  const path = fields["path"];
  if (typeof path !== "string") return;
  const caption = typeof fields["caption"] === "string" ? fields["caption"] : undefined;

  const image: ImageRef = { path, ...(caption !== undefined ? { caption } : {}) };
  for (let i = intermediateMessages.length - 1; i >= 0; i -= 1) {
    const message = intermediateMessages[i];
    if (message?.role === "assistant") {
      message.images.push(image);
      break;
    }
  }

  const data = imageDataForPath(path);
  exec.sendDirect({
    type: "send_image",
    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
    path,
    ...(caption !== undefined ? { caption } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}

function emitToolResult(
  exec: ToolExecution,
  toolUse: ToolUseEvent,
  output: string,
  isError: boolean,
): void {
  exec.sendDirect({
    type: "tool_result",
    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
    tool_id: toolUse.id,
    tool_name: toolUse.name,
    output,
    is_error: isError,
  });
}

export function recordReportedMessage(
  intermediateMessages: Message[],
  role: Role,
  blocks: ContentBlock[],
  exec: Pick<ToolExecution, "now" | "newMessageId">,
): void {
  intermediateMessages.push({
    msg_id: exec.newMessageId(),
    role,
    content: deriveContentFromBlocks(blocks, true),
    images: [],
    content_blocks: blocks,
    timestamp: exec.now(),
  });
}

export interface ToolPhase {
  readonly messages: Message[];
  runTool: (toolUse: ToolUseEvent) => Promise<ContentBlock>;
  recordTurn: (role: Role, blocks: ContentBlock[]) => void;
}

export function toolPhase(exec: ToolExecution, messages: Message[] = []): ToolPhase {
  return {
    messages,
    runTool: (toolUse) => executeToolUse(toolUse, exec, messages),
    recordTurn: (role, blocks) => recordReportedMessage(messages, role, blocks, exec),
  };
}
