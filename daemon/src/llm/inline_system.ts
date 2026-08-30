export const RECALLED_MEMORIES_TAG = "recalled_memories";

export function wrapInlineSystemInstruction(text: string): string {
  if (text.startsWith(`<${RECALLED_MEMORIES_TAG}>`)) return text;
  return `<system_instruction>${text}</system_instruction>`;
}
