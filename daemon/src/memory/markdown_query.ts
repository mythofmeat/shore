export function truncateChars(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}
