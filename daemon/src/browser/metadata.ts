import type { StreamMetadata } from "../protocol/StreamMetadata.ts";

export function accumulateMetadata(previous: StreamMetadata | null, incoming: StreamMetadata): StreamMetadata {
  if (previous === null) return incoming;
  const add = (a: number, b: number) => Math.min(Number(0xffff_ffff_ffff_ffffn), a + b);
  return { model: incoming.model, tokens: {
    input: add(previous.tokens.input, incoming.tokens.input), output: add(previous.tokens.output, incoming.tokens.output),
    cache_read: add(previous.tokens.cache_read, incoming.tokens.cache_read), cache_write: add(previous.tokens.cache_write, incoming.tokens.cache_write),
  }, timing: { total_ms: Math.min(4_294_967_295, previous.timing.total_ms + incoming.timing.total_ms), ttft_ms: previous.timing.ttft_ms } };
}

export function metadataLabel(metadata: StreamMetadata): string {
  return `${metadata.model} · in: ${String(metadata.tokens.input)} · out: ${String(metadata.tokens.output)} · cache: ${String(metadata.tokens.cache_read)} read / ${String(metadata.tokens.cache_write)} write · ${String(metadata.timing.total_ms)} ms · first token: ${String(metadata.timing.ttft_ms)} ms`;
}
