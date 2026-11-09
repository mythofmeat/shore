export const DAEMON_FLOORS: Readonly<Record<string, number>> = {};

export const DAEMON_EQUIVALENTS: readonly string[] = [
  "src/llm/image_dimensions.ts:webp: const head = read(0, 「16 → 17」);",
  "src/llm/image_dimensions.ts:jpeg: const soi = read(0, 「2 → 3」);",
  "src/llm/image_dimensions.ts:jpeg: const marker = read(offset, 「2 → 3」);",
  "src/llm/image_dimensions.ts:jpeg: …= read(offset + 2, frame ? 7 : 「2 → 3」);",
  "src/engine/embeds.ts:embedsIn: if (!text.includes(\"![\")) 「return []; → {}」",
  "src/engine/embeds.ts:pictureText: if (sent.length === 0) 「return text; → {}」",
];

export const CLIENT_FLOORS: Readonly<Record<string, number>> = {};

export const CLIENT_EQUIVALENTS: readonly string[] = [];
