import { shoreLog } from "../log.ts";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
import {
  base64Bytes,
  payloadText,
  toolMediaOf,
  type ToolMediaItem,
  type ToolResultPayload,
} from "./media.ts";
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
  onRecordTurn?: (message: Message) => void | Promise<void>;
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
    shoreLog.warn(`shore: rejected a ${toolUse.name} call — ${rejection}`);
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
  let payload: ToolResultPayload | undefined;
  try {
    const value = await dispatchWithinDeadline(
      toolUse.name,
      toolUse.input,
      { ...exec.ctx, toolUseId: toolUse.id },
      timeoutFor(exec.limits, toolUse.name),
    );
    payload = toolMediaOf(value);
    okValue = payload === undefined ? value : payload.value;
    rawOutput = joinLines([payloadText(okValue), ...(payload?.extra ?? [])]);
    isError = false;
  } catch (e) {
    rawOutput = e instanceof Error ? e.message : String(e);
    isError = true;
  }
  const dispatchMs = clock() - startedAt;

  const windowed = windowToolResult(rawOutput, resultCharsFor(exec.limits, toolUse.name));
  const attached = await attachToolMedia(payload, exec, toolUse);
  const output = joinLines([windowed.output, ...attached.notes]);

  if (!isError && toolUse.name === "generate_image") {
    attachGeneratedImage(okValue, intermediateMessages, exec);
  }

  emitToolResult(exec, toolUse, output, isError);

  return {
    block: {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: toolResultContent(output, attached.blocks),
      is_error: isError,
    },
    raw: rawOutput,
    isError,
    rejected: false,
    durationMs: dispatchMs,
    window: windowed,
  };
}

const MAX_INLINE_TOOL_IMAGES = 2;
const MAX_INLINE_TOOL_IMAGE_BYTES = 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

interface AttachedMedia {
  blocks: ContentBlock[];
  notes: string[];
}

function joinLines(parts: readonly string[]): string {
  return parts.filter((p) => p !== "").join("\n");
}

function toolResultContent(output: string, blocks: ContentBlock[]): string | ContentBlock[] {
  if (blocks.length === 0) return output;
  return output === "" ? blocks : [{ type: "text", text: output }, ...blocks];
}

async function attachToolMedia(
  payload: ToolResultPayload | undefined,
  exec: ToolExecution,
  toolUse: ToolUseEvent,
): Promise<AttachedMedia> {
  const attached: AttachedMedia = { blocks: [], notes: [] };
  if (payload === undefined || payload.media.length === 0) return attached;

  for (const [index, item] of payload.media.entries()) {
    const saved = await saveToolMedia(item, exec, toolUse, index);
    if (saved === undefined) {
      attached.notes.push(`[${item.label} could not be saved, and was not sent to the model]`);
      continue;
    }

    exec.sendDirect({
      type: "send_image",
      ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
      path: saved,
      caption: item.label,
      data: item.data,
    });

    const skipped = inlineRefusal(item, attached.blocks.length);
    if (skipped !== undefined) {
      attached.notes.push(`[${item.label} saved to ${saved}, not sent to the model: ${skipped}]`);
      continue;
    }

    attached.notes.push(`[${item.label} attached, saved to ${saved}]`);
    attached.blocks.push({
      type: "image",
      source: { type: "base64", media_type: item.mime_type, data: item.data },
    });
  }

  return attached;
}

function inlineRefusal(item: ToolMediaItem, alreadyInlined: number): string | undefined {
  if (alreadyInlined >= MAX_INLINE_TOOL_IMAGES) {
    return `at most ${String(MAX_INLINE_TOOL_IMAGES)} images are sent per tool result`;
  }
  const bytes = base64Bytes(item.data);
  if (bytes > MAX_INLINE_TOOL_IMAGE_BYTES) {
    return (
      `it is ${String(bytes)} bytes, over the ` +
      `${String(MAX_INLINE_TOOL_IMAGE_BYTES)}-byte inline limit`
    );
  }
  return undefined;
}

async function saveToolMedia(
  item: ToolMediaItem,
  exec: ToolExecution,
  toolUse: ToolUseEvent,
  index: number,
): Promise<string | undefined> {
  if (exec.ctx.imageDir === "") return undefined;
  const extension = EXTENSION_BY_MIME[item.mime_type] ?? "bin";
  const stamp = fileSafe(exec.now());
  const id = fileSafe(toolUse.id).slice(0, 24);
  const dir = join(exec.ctx.imageDir, "tools");
  const target = join(dir, `${stamp}_${id}_${String(index)}.${extension}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(target, Buffer.from(item.data, "base64"));
    return target;
  } catch (e) {
    shoreLog.warn(`shore: failed to save ${toolUse.name} image result: ${String(e)}`);
    return undefined;
  }
}

function fileSafe(raw: string): string {
  return Array.from(raw, (c) => (/[0-9A-Za-z]/.test(c) ? c : "_")).join("");
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
  exec: Pick<ToolExecution, "now" | "newMessageId" | "onRecordTurn">,
): void | Promise<void> {
  const message: Message = {
    msg_id: exec.newMessageId(),
    role,
    content: deriveContentFromBlocks(blocks, true),
    images: [],
    content_blocks: blocks,
    timestamp: exec.now(),
  };
  intermediateMessages.push(message);
  return exec.onRecordTurn?.(message);
}

export interface ToolPhase {
  readonly messages: Message[];
  runTool: (toolUse: ToolUseEvent) => Promise<ContentBlock>;
  recordTurn: (role: Role, blocks: ContentBlock[]) => void | Promise<void>;
}

export function toolPhase(exec: ToolExecution, messages: Message[] = []): ToolPhase {
  return {
    messages,
    runTool: (toolUse) => executeToolUse(toolUse, exec, messages),
    recordTurn: (role, blocks) => recordReportedMessage(messages, role, blocks, exec),
  };
}
