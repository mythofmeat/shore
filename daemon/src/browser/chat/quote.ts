export const QUOTE_EVENT = "shore:quote";
export const QUOTE_READY_EVENT = "shore:quote-ready";
export const QUOTE_SELECTION_EVENT = "shore:quote-selection";

export function quoteText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line === "" ? ">" : `> ${line}`).join("\n");
}

export function withQuote(draft: string, text: string): string {
  const quote = quoteText(text);
  if (quote === "") return draft;
  const before = draft.replace(/\s+$/, "");
  return `${before === "" ? "" : `${before}\n\n`}${quote}\n\n`;
}
