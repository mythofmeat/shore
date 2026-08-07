/**
 * Turning an assembled prompt into the wire message list.
 *
 * Ported from the second half of `crates/daemon/src/handler/task.rs`
 * (`build_llm_messages` and the three helpers under it), pinned by
 * `tests/handler_fixtures/context_parity.json`.
 *
 * Two jobs, and they are less alike than the single function suggests:
 *
 * 1. **Project stored blocks onto the wire.** In Rust this was
 *    `WireBlock::from_content_block`, a whole second enum that existed because
 *    the stored `ContentBlock` and the wire block were different types. Here
 *    they are the same type, so the projection is identity and the function is
 *    gone rather than ported — see {@link renderMessageContent}. What survives
 *    is the *filtering*: empty text blocks are dropped, and a turn that renders
 *    to nothing is dropped with them.
 *
 * 2. **Reroute images on assistant turns.** Anthropic rejects a raw `image`
 *    block inside an assistant turn at any position, and one such turn fails
 *    the entire request — so a persisted assistant message carrying a generated
 *    image would wedge the conversation on every subsequent send. The image
 *    replays as the tool call it originally was, or folds into a text stand-in
 *    where tool blocks cannot ship. See {@link AssistantImageMode}.
 *
 * The empty-block filtering is deliberately *not* the guarantee that no empty
 * text block reaches a provider — that is the adapter's, because the tool loop
 * and the `last_request` append path never come through here. What this side
 * knows, and the adapter does not, is whether the stored blocks render to
 * anything, which is what decides between them and the derived `content`
 * string.
 *
 * What this also does not do is decide what a provider will accept.
 * Carrier-less thinking, thinking minted by another model, and prior turns'
 * thinking under a `none` replay setting all ship from here and are filtered in
 * `llm/replay.ts`, which is the only place that knows the provider.
 */

import { basename } from "node:path";

import type { ImageRef, ContentBlock } from "../engine/types.ts";
import type { AssembledPrompt, PromptMessage } from "../engine/prompt.ts";
import type { Sdk, SystemBlock, WireMessage } from "../llm/types.ts";
import { buildContent, encodeImageBlock, type CachedResize } from "./images.ts";

/**
 * How images attached to *assistant* messages render on the wire.
 *
 * `tool_pair` is the only wire position where the model can actually see the
 * image it generated; `text_standin` is what is left when tool blocks cannot
 * ship at all.
 */
export type AssistantImageMode = "tool_pair" | "text_standin";

/**
 * Pick the mode for one request.
 *
 * Tool blocks need two things at once: an Anthropic-dialect request (an
 * image-bearing `tool_result` is not portable to the other SDKs' tool-message
 * shapes) and a non-empty `tools` param (tool blocks require one). Miss either
 * and the image has to become text.
 */
export function assistantImageModeForRequest(sdk: Sdk, hasToolDefs: boolean): AssistantImageMode {
  return sdk === "anthropic" && hasToolDefs ? "tool_pair" : "text_standin";
}

/** Rendered wire form of the images on one assistant message. */
interface AssistantImageRender {
  /** Blocks appended to the assistant turn itself. */
  assistantBlocks: ContentBlock[];
  /** `tool_result` blocks owed to the turn immediately after (empty in `text_standin`). */
  toolResults: ContentBlock[];
}

/**
 * Deterministic `tool_use` id for a replayed generated image.
 *
 * The same history must render byte-identically across requests, processes and
 * daemon restarts or the prompt cache misses, so the id derives from the
 * image's file stem — unique per generated image — and never from randomness or
 * an unstable hash.
 *
 * The stem is Rust's `Path::file_stem`, which is not `basename` minus the last
 * dot: a leading-dot name has no extension to strip, so `.png` stems to `.png`
 * and sanitizes to `_png` rather than to the empty string.
 */
export function syntheticToolUseId(path: string, index: number): string {
  const stem = fileStem(path) ?? "image";
  const safe = [...stem]
    .map((c) => (/[0-9A-Za-z]/.test(c) ? c : "_"))
    .slice(0, 48)
    .join("");
  return `toolu_gen_${index}_${safe}`;
}

/** `Path::file_stem`: the file name up to, but not including, the final dot —
 * except that a name which is all one leading dot has no extension at all. */
function fileStem(path: string): string | undefined {
  const name = basename(path);
  if (name === "" || name === "." || name === "..") return undefined;
  const dot = name.lastIndexOf(".");
  // `dot === 0` is a dotfile: the whole name is the stem.
  return dot <= 0 ? name : name.slice(0, dot);
}

/** A caption is what is left after trimming, when that is not empty. */
function usableCaption(img: ImageRef): string | undefined {
  const caption = img.caption?.trim();
  return caption === undefined || caption === "" ? undefined : caption;
}

async function renderAssistantImages(
  images: readonly ImageRef[],
  mode: AssistantImageMode,
  maxImageSize: number,
  cacheDir: string,
  resize: CachedResize | undefined,
): Promise<AssistantImageRender> {
  const render: AssistantImageRender = { assistantBlocks: [], toolResults: [] };

  for (const [index, img] of images.entries()) {
    const source =
      mode === "tool_pair"
        ? await encodeImageBlock(img, maxImageSize, cacheDir, resize)
        : undefined;
    const caption = usableCaption(img);

    if (source === undefined) {
      // `text_standin` mode — or the image failed to encode (missing or
      // unreadable file), where emitting the `tool_use` anyway would leave it
      // dangling without a result and fail the request.
      render.assistantBlocks.push({
        type: "text",
        text: caption === undefined ? "[sent an image]" : `[sent an image: ${caption}]`,
      });
      continue;
    }

    const id = syntheticToolUseId(img.path, index);
    render.assistantBlocks.push({
      type: "tool_use",
      id,
      name: "generate_image",
      // The generation prompt isn't persisted, so the input carries only what
      // is: the caption.
      input: caption === undefined ? {} : { caption },
    });
    const content: ContentBlock[] = [{ type: "image", source }];
    if (caption !== undefined) content.push({ type: "text", text: caption });
    // No `is_error`. The Rust set it to `false` and then skipped it on the
    // wire (`skip_serializing_if = "Not::not"`), and the Anthropic adapter
    // reads it as `if (b.is_error)` — so absent and `false` are the same
    // claim, and the absent one is the one that was actually sent.
    render.toolResults.push({ type: "tool_result", tool_use_id: id, content });
  }

  return render;
}

/**
 * Render one prompt message's wire content, plus the `tool_result` blocks it
 * owes the following turn.
 *
 * Returns `undefined` for a message that rendered to nothing — a degenerate
 * persisted turn with no usable content, such as an assistant turn that ended a
 * tool loop without emitting any final text. Anthropic rejects such a turn with
 * "messages: text content blocks must be non-empty" and fails the *entire*
 * request, so a conversation whose window contained one could no longer
 * generate at all.
 */
async function renderMessageContent(
  m: PromptMessage,
  maxImageSize: number,
  cacheDir: string,
  mode: AssistantImageMode,
  resize: CachedResize | undefined,
): Promise<{ content: ContentBlock[]; owedToolResults: ContentBlock[] } | undefined> {
  // Images on assistant turns can't ship as raw `image` blocks; render them
  // separately and keep them out of the shared content paths below.
  const reroute = m.role === "assistant" && m.images.length > 0;
  const imageRender = reroute
    ? await renderAssistantImages(m.images, mode, maxImageSize, cacheDir, resize)
    : undefined;
  const turnImages = reroute ? [] : m.images;

  const fallback = () => buildContent(m.content, turnImages, maxImageSize, cacheDir, resize);

  let content: ContentBlock[];
  if (m.content_blocks.length === 0) {
    content = await fallback();
  } else {
    const blocks: ContentBlock[] = [];
    for (const img of turnImages) {
      const source = await encodeImageBlock(img, maxImageSize, cacheDir, resize);
      if (source !== undefined) blocks.push({ type: "image", source });
    }
    blocks.push(...m.content_blocks.filter((b) => !(b.type === "text" && b.text.trim() === "")));

    // A turn whose only stored block was empty text renders to nothing; fall
    // back to the derived `content` string so a turn with text in it is not
    // silently dropped.
    content = blocks.length === 0 ? await fallback() : blocks;
  }

  if (imageRender !== undefined) content = [...content, ...imageRender.assistantBlocks];
  if (content.length === 0) return undefined;

  return { content, owedToolResults: imageRender?.toolResults ?? [] };
}

/**
 * Convert assembled prompt messages into the wire message list and the system
 * blocks that go beside them.
 *
 * `resize` is the image-resize ladder; omit it to encode images at their stored
 * size.
 */
export async function buildLlmMessages(
  prompt: AssembledPrompt,
  maxImageSize: number,
  cacheDir: string,
  mode: AssistantImageMode,
  resize?: CachedResize,
): Promise<{ messages: WireMessage[]; system: SystemBlock[] }> {
  const messages: WireMessage[] = [];
  // `tool_result` blocks owed by a preceding assistant turn whose images
  // rendered as synthetic `generate_image` tool calls. The API requires a
  // tool_use's result in the turn immediately after it, so these merge into the
  // front of the next emitted user message — or become a user turn of their own
  // when the next emitted message isn't one, or nothing follows.
  let pending: ContentBlock[] = [];

  for (const m of prompt.messages) {
    const rendered = await renderMessageContent(m, maxImageSize, cacheDir, mode, resize);
    if (rendered === undefined) {
      // Dropped empty turn; anything owed survives to the next emitted message.
      continue;
    }

    let content = rendered.content;
    if (pending.length > 0) {
      const owed = pending;
      pending = [];
      if (m.role === "user") {
        content = [...owed, ...content];
      } else {
        messages.push({ role: "user", content: owed });
      }
    }

    // Provenance travels with the turn so the adapter can decide whether this
    // turn's thinking is replayable to the active model.
    messages.push({
      role: m.role,
      content,
      ...(m.provider_key === undefined ? {} : { provider_key: m.provider_key }),
      ...(m.model === undefined ? {} : { model: m.model }),
    });
    pending.push(...rendered.owedToolResults);
  }

  if (pending.length > 0) messages.push({ role: "user", content: pending });

  // Every block keeps its label. This used to fork on count — one block
  // serialized as a bare string, dropping the label with it — so a single-block
  // system prompt silently lost the anchor placement the label exists to drive.
  const system: SystemBlock[] = prompt.system.map((b) => ({ text: b.content, label: b.label }));

  return { messages, system };
}
