import type { SidecarRequest } from "./types.ts";
import type { ContentBlock } from "../engine/types.ts";

const MAX_BASE64_BYTES = 5_000_000;

export async function prepareImageBlock(block: ContentBlock): Promise<ContentBlock> {
  if (block.type === "tool_result" && Array.isArray(block.content)) {
    return { ...block, content: await prepareImageBlocks(block.content) };
  }
  if (block.type !== "image" || block.source.data.length <= MAX_BASE64_BYTES) return block;
  const bytes = Buffer.from(block.source.data, "base64");
  const pipeline = (size: number) => new Bun.Image(bytes).resize(size, size, {
    fit: "inside", withoutEnlargement: true,
  });
  const lossless = await pipeline(2000).png().toBase64();
  if (lossless.length <= MAX_BASE64_BYTES) {
    return { ...block, source: { type: "base64", media_type: "image/png", data: lossless } };
  }
  for (let size = 2000; size >= 1; size = Math.floor(size / 2)) {
    const data = await pipeline(size).webp({ quality: 85 }).toBase64();
    if (data.length <= MAX_BASE64_BYTES) {
      return { ...block, source: { type: "base64", media_type: "image/webp", data } };
    }
  }
  throw new Error("Image could not be reduced below the 5 MB base64 limit");
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
