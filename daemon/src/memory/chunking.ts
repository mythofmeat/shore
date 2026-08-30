export function chunkText(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return text === "" ? [] : [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const idealEnd = Math.min(start + maxChars, text.length);
    let end = idealEnd;
    if (idealEnd < text.length) {
      const floor = start + Math.floor(maxChars * 0.55);
      const paragraph = text.lastIndexOf("\n\n", idealEnd);
      const sentence = lastSentenceBoundary(text, idealEnd, floor);
      const line = text.lastIndexOf("\n", idealEnd);
      end = paragraph >= floor ? paragraph + 2 : sentence >= floor ? sentence : line >= floor ? line + 1 : idealEnd;
    }
    const chunk = text.slice(start, end);
    if (chunk !== "") chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function lastSentenceBoundary(text: string, end: number, floor: number): number {
  for (let i = end - 1; i >= floor; i -= 1) {
    if (/[.!?。！？]/u.test(text[i] ?? "") && /\s/u.test(text[i + 1] ?? "")) return i + 1;
  }
  return -1;
}
