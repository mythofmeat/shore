import type { BashResult } from "./bash.ts";
import { formatToolOutput } from "./output.ts";
import { shoreLog } from "../log.ts";
import {
  DEFAULT_IMAGE_LIMITS,
  fullResolution,
  ORIGINAL_IMAGE_SETTINGS,
  reduceImage,
  type ImageLimits,
  type ReducedImage,
} from "../llm/prepare_images.ts";
import { resolveImageBlock } from "../llm/images.ts";
import { defaultImagesConfig, imageSettingsFor } from "../config/app.ts";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { deriveContentFromBlocks } from "../engine/message_store.ts";
import type { ContentBlock, ImageRef, Message, Role } from "../engine/types.ts";
import { imageDataForPath } from "../engine/wire_images.ts";
import type { ToolUseEvent } from "../engine/tool_loop.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import {
  dispatchWithinDeadline,
  inlineImageBytesFor,
  resultCharsFor,
  timeoutFor,
  windowToolResult,
  type ToolContext,
  type ToolLimitsView,
  type ToolResultWindow,
} from "./dispatch.ts";
import {
  MAX_INLINE_TOOL_IMAGES,
  MAX_LISTED_MEDIA_NOTES,
  reductionNote,
  toolMediaOf,
  type ToolMediaItem,
  type ToolResultPayload,
} from "./media.ts";
import { schemaViolation, type ToolSchemas } from "./validate.ts";
import { base64Bytes } from "../util/base64.ts";

export interface ToolExecution {
  sendDirect: (message: ServerMessage) => void;
  ctx: ToolContext;
  limits: ToolLimitsView;
  imageLimits?: ImageLimits;
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
  output: string;
  raw: string;
  isError: boolean;
  rejected: boolean;
  durationMs: number;
  window?: ToolResultWindow;
  value?: unknown;
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
      output: rejection,
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
      { ...exec.ctx, toolUseId: toolUse.id, maxResultChars: resultCharsFor(exec.limits, toolUse.name), maxInlineImageBytes: inlineImageBytesFor(exec.limits, toolUse.name) },
      timeoutFor(exec.limits, toolUse.name),
    );
    payload = toolMediaOf(value);
    okValue = payload === undefined ? value : payload.value;
    rawOutput = joinLines([formatToolOutput(toolUse.name, okValue), ...(payload?.extra ?? [])]);
    isError = ["bash", "apply_patch"].includes(toolUse.name) && (okValue as BashResult).exit_code !== 0;
  } catch (e) {
    rawOutput = e instanceof Error ? e.message : String(e);
    if (toolUse.name === "apply_patch") rawOutput += "\nNative patches apply sequentially; earlier changes may remain after failure or cancellation. Inspect affected files before retrying.";
    isError = true;
  }
  const dispatchMs = clock() - startedAt;

  const windowed = windowToolResult(rawOutput, resultCharsFor(exec.limits, toolUse.name));
  const attached = await attachToolMedia(payload, exec, toolUse);
  isError ||= attached.failed;
  const output = joinLines([windowed.output, ...(payload?.notes ?? []), ...attached.notes]);

  if (!isError && toolUse.name === "generate_image") {
    attachGeneratedImage(okValue, intermediateMessages, exec);
  }

  emitToolResult(exec, toolUse, output, isError, attached.images);

  return {
    block: {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: toolResultContent(output, attached.blocks),
      is_error: isError,
    },
    output,
    raw: rawOutput,
    isError,
    rejected: false,
    durationMs: dispatchMs,
    window: windowed,
    value: okValue,
  };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

interface AttachedMedia {
  blocks: ContentBlock[];
  images: ImageRef[];
  notes: string[];
  failed: boolean;
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
  const attached: AttachedMedia = { blocks: [], images: [], notes: [], failed: false };
  if (payload === undefined || payload.media.length === 0) return attached;
  const maxBytes = inlineImageBytesFor(exec.limits, toolUse.name);
  let inlinedBytes = 0;
  const skipped: string[] = [];

  for (const [index, item] of payload.media.entries()) {
    const saved = await saveToolMedia(item, exec, toolUse, index);
    if (saved === undefined) {
      attached.notes.push(`[${item.label}: a separate media copy could not be saved]`);
    } else {
      exec.sendDirect({
        type: "send_image",
        ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
        path: saved,
        caption: item.label,
        data: item.data,
      });
    }
    const original: ImageRef = { path: saved ?? `tool-image:${toolUse.id}:${String(index)}`, caption: item.label, data: item.data };
    if (attached.blocks.length >= MAX_INLINE_TOOL_IMAGES || inlinedBytes >= maxBytes) {
      skipped.push(item.label);
      attached.images.push(original);
      continue;
    }
    try {
      const reduced = await reduceToolImage(item, exec, toolUse);
      const block: ContentBlock = { type: "image", source: reduced.source };
      const resolution = resolveImageBlock(block.source);
      if ("omitted" in resolution) throw new Error(resolution.omitted);
      const bytes = base64Bytes(block.source.data);
      if (bytes > maxBytes - inlinedBytes) {
        skipped.push(item.label);
        attached.images.push(original);
        continue;
      }
      const note = toolImageNote(item, reduced, exec, toolUse);
      if (note !== undefined) attached.notes.push(note);
      attached.notes.push(`[${item.label} attached${saved === undefined ? "" : `, saved to ${saved}`}]`);
      attached.blocks.push(block);
      inlinedBytes += bytes;
      attached.images.push({ ...original, data: block.source.data });
    } catch (error) {
      attached.failed = true;
      attached.images.push(original);
      attached.notes.push(`[${item.label} not sent to the model: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }

  if (skipped.length > 0) attached.notes.push(skippedNote(skipped, maxBytes));
  return attached;
}

async function reduceToolImage(item: ToolMediaItem, exec: ToolExecution, toolUse: ToolUseEvent): Promise<ReducedImage> {
  const limits = exec.imageLimits ?? DEFAULT_IMAGE_LIMITS;
  const source = { type: "base64" as const, media_type: item.mime_type, data: item.data };
  if (item.original === true) return await reduceImage(source, ORIGINAL_IMAGE_SETTINGS, limits);
  const settings = imageSettingsFor(exec.ctx.images ?? defaultImagesConfig(), toolUse.name === "read" ? "read" : "mcp");
  return await reduceImage(source, settings, { maxEdge: limits.maxEdge });
}

function toolImageNote(item: ToolMediaItem, reduced: ReducedImage, exec: ToolExecution, toolUse: ToolUseEvent): string | undefined {
  const read = (exec.ctx.images ?? defaultImagesConfig()).read;
  const fromFile = item.reducedFrom === undefined ? reduced : { ...reduced, original: item.reducedFrom, changed: true };
  if (toolUse.name !== "read" || !fromFile.changed || !read.tell_model) return undefined;
  const limits = exec.imageLimits ?? DEFAULT_IMAGE_LIMITS;
  return reductionNote({
    item,
    reduced: fromFile,
    tier: limits.tier,
    fullSize: fullResolution(fromFile.original.dimensions, limits),
    offerOriginal: read.allow_original,
  });
}

function skippedNote(labels: readonly string[], maxBytes: number): string {
  const listed = labels.slice(0, MAX_LISTED_MEDIA_NOTES).join(", ");
  const more = labels.length > MAX_LISTED_MEDIA_NOTES ? ` and ${String(labels.length - MAX_LISTED_MEDIA_NOTES)} more` : "";
  const reason = maxBytes === 0
    ? "inline images are disabled for this tool"
    : `at most ${String(MAX_INLINE_TOOL_IMAGES)} images and ${String(maxBytes)} bytes of prepared image data are sent per tool result`;
  return `[${listed}${more} not sent to the model: ${reason}]`;
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
    toolUse.input_error ?? (schemas !== undefined && !schemas.has(toolUse.name)
      ? "this tool is not available in the current tool set"
      : schemaViolation(schemas?.get(toolUse.name), toolUse.input));
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
  images: ImageRef[] = [],
): void {
  exec.sendDirect({
    type: "tool_result",
    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
    tool_id: toolUse.id,
    tool_name: toolUse.name,
    output,
    ...(images.length > 0 ? { images } : {}),
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
  onTurn?: (turn: import("../llm/types.ts").GenerateResponse) => void | Promise<void>;
  afterTurn?: (turn: import("../llm/types.ts").GenerateResponse) => void | Promise<void>;
  beforeTurn?: (request: import("../llm/types.ts").SidecarRequest) => void | Promise<void>;
  parallel?: boolean;
  readonly messages: Message[];
  runTool: (toolUse: ToolUseEvent) => Promise<ContentBlock>;
  recordTurn: (role: Role, blocks: ContentBlock[]) => void | Promise<void>;
}

export function toolPhase(exec: ToolExecution, messages: Message[] = []): ToolPhase {
  return {
    messages,
    ...(exec.ctx.trackWorkspaceWrite === undefined ? {} : { parallel: false }),
    runTool: (toolUse) => executeToolUse(toolUse, exec, messages),
    recordTurn: (role, blocks) => recordReportedMessage(messages, role, blocks, exec),
  };
}
