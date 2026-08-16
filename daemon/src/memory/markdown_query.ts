export function truncateChars(text: string, limit: number): string {
  return [...text].slice(0, limit).join("");
}
