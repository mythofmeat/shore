import type { SidecarRequest } from "./types.ts";
import type { ContentBlock } from "../engine/types.ts";

const MAX_BASE64_BYTES = 1_000_000;
const MAX_IMAGE_EDGE = 2000;

export async function prepareImageBlock(block: ContentBlock): Promise<ContentBlock> {
  if (block.type === "tool_result" && Array.isArray(block.content)) {
    return { ...block, content: await prepareImageBlocks(block.content) };
  }
  if (block.type !== "image") return block;
  const bytes = Buffer.from(block.source.data, "base64");
  const metadata = await new Bun.Image(bytes).metadata().catch(() => undefined);
  if (block.source.data.length <= MAX_BASE64_BYTES && (
    metadata === undefined || Math.max(metadata.width, metadata.height) <= MAX_IMAGE_EDGE
  )) return block;
  const pipeline = (size: number) => new Bun.Image(bytes).resize(size, size, {
    fit: "inside", withoutEnlargement: true,
  });
  const size = Math.min(MAX_IMAGE_EDGE, Math.max(metadata?.width ?? MAX_IMAGE_EDGE, metadata?.height ?? MAX_IMAGE_EDGE));
  const lossless = await pipeline(size).png().toBase64();
  if (lossless.length <= MAX_BASE64_BYTES) {
    return { ...block, source: { type: "base64", media_type: "image/png", data: lossless } };
  }
  for (let edge = size; edge >= 1; edge = Math.floor(edge * 0.8)) {
    const data = await pipeline(edge).webp({ quality: 85 }).toBase64();
    if (data.length <= MAX_BASE64_BYTES) {
      return { ...block, source: { type: "base64", media_type: "image/webp", data } };
    }
  }
  throw new Error("Image could not be reduced below the 1 MB base64 limit");
}

export async function prepareImageBlocks(blocks: readonly ContentBlock[]): Promise<ContentBlock[]> {
  const prepared: ContentBlock[] = [];
  for (const block of blocks) {
    prepared.push(await prepareImageBlock(block));
  }
  return prepared;
}

export async function prepareRequestImages(request: SidecarRequest): Promise<SidecarRequest> {
  const messages = [];
  for (const message of request.messages) {
    messages.push({ ...message, content: await prepareImageBlocks(message.content) });
  }
  return { ...request, messages };
}
