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
import { defaultImagesConfig, imageSettingsFor, TOOLS_NOW_PART_OF } from "../config/app.ts";
import { keepCachedImage, noteCachedImages, toolImageCacheDir } from "../storage/image_cache.ts";
import { insideWorkspace } from "../storage/image_locations.ts";

import { deriveContentFromBlocks } from "../engine/message_store.ts";
import type { ContentBlock, ImageRef, Message, Role } from "../engine/types.ts";
import { sha256Hex } from "../engine/picture_files.ts";
import type { ToolUseEvent } from "../engine/tool_loop.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import {
  dispatchWithinDeadline,
  inlineImageBytesFor,
  resultCharsFor,
  timeoutFor,
  windowToolResult,
  writesWorkspace,
  type ToolContext,
  type ToolLimitsView,
  type ToolResultWindow,
} from "./dispatch.ts";
import {
  MAX_INLINE_TOOL_IMAGES,
  reductionNote,
  toolMediaOf,
  type ToolMediaItem,
  type ToolResultPayload,
} from "./media.ts";
import { schemaViolation, type ToolSchemas } from "./validate.ts";
import { toolResultText } from "../llm/types.ts";
import { base64Bytes } from "../util/base64.ts";
import { errorText } from "./errors.ts";
import { listSome } from "./media.ts";
import type { Texts } from "../texts/texts.ts";

export interface ToolExecution {
  sendDirect: (message: ServerMessage) => void;
  ctx: ToolContext;
  limits: ToolLimitsView;
  imageLimits?: ImageLimits | undefined;
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
  pictures: ImageRef[];
}

export async function runToolUse(
  toolUse: ToolUseEvent,
  exec: ToolExecution,
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

  const rejection = argumentRejection(exec.ctx.texts, toolUse, exec.schemas);
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
      pictures: [],
    };
  }

  const maxResultChars = resultCharsFor(exec.limits, toolUse.name);
  let rawOutput: string;
  let isError: boolean;
  let payload: ToolResultPayload | undefined;
  try {
    const dispatch = async () => await dispatchWithinDeadline(
      toolUse.name,
      toolUse.input,
      { ...exec.ctx, toolUseId: toolUse.id, maxResultChars, maxInlineImageBytes: inlineImageBytesFor(exec.limits, toolUse.name) },
      timeoutFor(exec.limits, toolUse.name),
    );
    const record = exec.ctx.recordWorkspaceWrite;
    const value = record !== undefined && writesWorkspace(toolUse.name) ? await record(dispatch) : await dispatch();
    payload = toolMediaOf(value);
    const okValue = payload === undefined ? value : payload.value;
    rawOutput = joinLines([formatToolOutput(exec.ctx.texts, toolUse.name, okValue), ...(payload?.extra ?? [])]);
    isError = ["bash", "apply_patch"].includes(toolUse.name) && (okValue as BashResult).exit_code !== 0;
  } catch (e) {
    rawOutput = errorText(exec.ctx.texts, e);
    const patchNote = toolUse.name === "apply_patch" ? exec.ctx.texts.render("patch_failed") : undefined;
    if (patchNote !== undefined) rawOutput += `\n${patchNote}`;
    isError = true;
  }
  const dispatchMs = clock() - startedAt;

  const windowed = windowToolResult(exec.ctx.texts, rawOutput, maxResultChars);
  const attached = await attachToolMedia(payload, exec, toolUse);
  isError ||= attached.failed;
  const content = toolResultContent(windowed, [...(payload?.notes ?? []), ...attached.notes], attached.placed);
  const output = toolResultText(content);

  emitToolResult(exec, toolUse, output, isError, attached.images);

  return {
    block: {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content,
      is_error: isError,
    },
    output,
    raw: rawOutput,
    isError,
    rejected: false,
    durationMs: dispatchMs,
    window: windowed,
    pictures: attached.shown,
  };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

interface PlacedImage {
  block: ContentBlock;
  notes: string[];
  at?: number;
}

interface AttachedMedia {
  placed: PlacedImage[];
  images: ImageRef[];
  shown: ImageRef[];
  notes: string[];
  failed: boolean;
}

function joinLines(parts: readonly string[]): string {
  return parts.filter((p) => p !== "").join("\n");
}

function toolResultContent(windowed: ToolResultWindow, notes: string[], placed: PlacedImage[]): string | ContentBlock[] {
  if (placed.length === 0) return joinLines([windowed.output, ...notes]);
  const fits = (at: number | undefined): at is number => !windowed.truncated && at !== undefined && at <= windowed.output.length;
  const inline = placed.filter((image) => fits(image.at)).toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const content: ContentBlock[] = [];
  let text: string[] = [];
  const show = (image: PlacedImage) => {
    const caption = joinLines([...text, ...image.notes]);
    if (caption !== "") content.push({ type: "text", text: caption });
    content.push(image.block);
    text = [];
  };
  let cursor = 0;
  for (const image of inline) {
    const at = image.at ?? cursor;
    text.push(windowed.output.slice(cursor, at).replace(/\n$/, ""));
    show(image);
    cursor = at;
  }
  text.push(windowed.output.slice(cursor), ...notes);
  for (const image of placed.filter((candidate) => !fits(candidate.at))) show(image);
  const rest = joinLines(text);
  if (rest !== "") content.push({ type: "text", text: rest });
  return content;
}

async function attachToolMedia(
  payload: ToolResultPayload | undefined,
  exec: ToolExecution,
  toolUse: ToolUseEvent,
): Promise<AttachedMedia> {
  const attached: AttachedMedia = { placed: [], images: [], shown: [], notes: [], failed: false };
  if (payload === undefined || payload.media.length === 0) return attached;
  const maxBytes = inlineImageBytesFor(exec.limits, toolUse.name);
  let inlinedBytes = 0;
  const skipped: string[] = [];

  for (const [index, item] of payload.media.entries()) {
    const saved = await saveToolMedia(item, exec, toolUse);
    const unsaved = [saved === undefined ? exec.ctx.texts.render("tool_media_unsaved", { label: item.label }) : undefined].filter((note) => note !== undefined);
    if (saved !== undefined) {
      exec.sendDirect({
        type: "send_image",
        ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
        path: saved.path,
        caption: item.label,
        data: item.data,
      });
    }
    const original: ImageRef = {
      path: saved?.path ?? `tool-image:${toolUse.id}:${String(index)}`,
      caption: item.label,
      data: item.data,
      ...(saved === undefined ? {} : { sha256: saved.sha256 }),
    };
    if (attached.placed.length >= MAX_INLINE_TOOL_IMAGES || inlinedBytes >= maxBytes) {
      attached.notes.push(...unsaved);
      skipped.push(item.label);
      attached.images.push(original);
      continue;
    }
    try {
      const reduced = await reduceToolImage(item, exec, toolUse);
      const block: ContentBlock = { type: "image", source: reduced.source };
      const resolution = resolveImageBlock(block.source);
      if ("omitted" in resolution) throw new Error(exec.ctx.texts.render(resolution.omitted.reason, resolution.omitted.values) ?? "");
      const bytes = base64Bytes(block.source.data);
      if (bytes > maxBytes - inlinedBytes) {
        attached.notes.push(...unsaved);
        skipped.push(item.label);
        attached.images.push(original);
        continue;
      }
      const note = toolImageNote(item, reduced, exec, toolUse);
      const attachedNote = exec.ctx.texts.render("tool_media_attached", { label: item.label, file: saved === undefined || item.path !== undefined ? undefined : saved.path });
      const notes = [...unsaved, note, attachedNote].filter((each) => each !== undefined);
      attached.placed.push({ block, notes, ...(item.at === undefined ? {} : { at: item.at }) });
      inlinedBytes += bytes;
      attached.images.push({ ...original, data: block.source.data });
      if (saved !== undefined) {
        attached.shown.push({ path: saved.path, caption: item.label, sha256: saved.sha256 });
      }
    } catch (error) {
      attached.failed = true;
      attached.images.push(original);
      attached.notes.push(...unsaved);
      const failed = exec.ctx.texts.render("tool_media_failed", { label: item.label, error: error instanceof Error ? error.message : String(error) });
      if (failed !== undefined) attached.notes.push(failed);
    }
  }

  const skippedText = skipped.length > 0 ? skippedNote(exec.ctx.texts, skipped, maxBytes) : undefined;
  if (skippedText !== undefined) attached.notes.push(skippedText);
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
  return reductionNote(exec.ctx.texts, {
    item,
    reduced: fromFile,
    tier: limits.tier,
    fullSize: fullResolution(fromFile.original.dimensions, limits),
    offerOriginal: read.allow_original,
  });
}

function skippedNote(texts: Texts, labels: readonly string[], maxBytes: number): string | undefined {
  return texts.render("tool_media_skipped", { labels: listSome(texts, labels), off: maxBytes === 0 ? "yes" : undefined, images: String(MAX_INLINE_TOOL_IMAGES), bytes: String(maxBytes) });
}

async function saveToolMedia(
  item: ToolMediaItem,
  exec: ToolExecution,
  toolUse: ToolUseEvent,
): Promise<{ path: string; sha256: string } | undefined> {
  const bytes = Buffer.from(item.data, "base64");
  if (item.path !== undefined && item.reducedFrom === undefined && insideWorkspace(item.path, exec.ctx.workspaceDir)) {
    return { path: item.path, sha256: sha256Hex(bytes) };
  }
  const cache = exec.ctx.cacheDir;
  if (cache === undefined || cache === "") return undefined;
  try {
    const kept = await keepCachedImage(toolImageCacheDir(cache, exec.ctx.characterName), bytes, EXTENSION_BY_MIME[item.mime_type] ?? "bin");
    if (kept.added) noteCachedImages(cache, bytes.byteLength);
    return { path: kept.path, sha256: kept.sha256 };
  } catch (e) {
    shoreLog.warn(`shore: failed to save ${toolUse.name} image result: ${String(e)}`);
    return undefined;
  }
}

function notOffered(texts: Texts, name: string, schemas: ToolSchemas): string {
  const now = TOOLS_NOW_PART_OF.get(name);
  return now !== undefined && schemas.has(now)
    ? texts.always("tool_merged", { tool: now, push: now === "send_message" ? "yes" : undefined })
    : texts.always("tool_not_offered");
}

export function argumentRejection(
  texts: Texts,
  toolUse: ToolUseEvent,
  schemas: ToolSchemas | undefined,
): string | undefined {
  const unparsed = toolUse.input_error === undefined ? undefined : texts.always("tool_arg_json", { why: toolUse.input_error, chars: String(toolUse.input_length ?? 0) });
  const reason =
    unparsed ?? (schemas !== undefined && !schemas.has(toolUse.name)
      ? notOffered(texts, toolUse.name, schemas)
      : schemaViolation(texts, schemas?.get(toolUse.name), toolUse.input));
  if (reason === undefined) return undefined;
  return texts.always("tool_rejected", { tool: toolUse.name, reason });
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
  images: ImageRef[] = [],
): void | Promise<void> {
  const message: Message = {
    msg_id: exec.newMessageId(),
    role,
    content: deriveContentFromBlocks(blocks, true),
    images,
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
  const pictures = new Map<string, ImageRef[]>();
  const taken = (id: string): ImageRef[] => {
    const shown = pictures.get(id) ?? [];
    pictures.delete(id);
    return shown;
  };
  return {
    messages,
    ...(exec.ctx.trackWorkspaceWrite === undefined ? {} : { parallel: false }),
    runTool: async (toolUse) => {
      const run = await runToolUse(toolUse, exec);
      pictures.set(toolUse.id, run.pictures);
      return run.block;
    },
    recordTurn: (role, blocks) => recordReportedMessage(messages, role, blocks, exec, blocks.flatMap((block) => block.type === "tool_result" ? taken(block.tool_use_id) : [])),
  };
}
