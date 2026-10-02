export interface Shortcut { keys: string[]; description: string; where: "Anywhere" | "Message box" | "Conversation" }

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ["Mod", "K"], description: "Open the command palette", where: "Anywhere" },
  { keys: ["Mod", "/"], description: "Focus the message box", where: "Anywhere" },
  { keys: ["Mod", "Shift", "O"], description: "New conversation", where: "Anywhere" },
  { keys: ["Alt", "↑ / ↓"], description: "Previous or next conversation", where: "Anywhere" },
  { keys: ["Mod", "\\"], description: "Show or hide the sidebar", where: "Anywhere" },
  { keys: ["Mod", ","], description: "Open settings", where: "Anywhere" },
  { keys: ["?"], description: "Show keyboard shortcuts", where: "Anywhere" },
  { keys: ["Enter"], description: "Send (Shift+Enter for a new line)", where: "Message box" },
  { keys: ["↑"], description: "Edit your last message when the box is empty", where: "Message box" },
  { keys: ["← / →"], description: "Previous or next response when the box is empty", where: "Message box" },
  { keys: ["Esc"], description: "Stop a response, or move focus to the conversation", where: "Message box" },
  { keys: ["↑ ↓ PgUp PgDn Home End"], description: "Scroll the conversation", where: "Conversation" },
];

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function keyLabel(key: string): string {
  return key === "Mod" ? IS_MAC ? "⌘" : "Ctrl" : key;
}

export type GlobalAction = "palette" | "focus" | "new-thread" | "previous-thread" | "next-thread" | "sidebar" | "settings" | "help";

export interface KeyInput { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

export function globalAction(event: KeyInput, typing: boolean): GlobalAction | undefined {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") return "palette";
  if (mod && !event.altKey && event.key === "/") return "focus";
  if (mod && event.shiftKey && event.key.toLowerCase() === "o") return "new-thread";
  if (mod && !event.shiftKey && event.key === "\\") return "sidebar";
  if (mod && !event.shiftKey && event.key === ",") return "settings";
  if (event.altKey && !mod && !event.shiftKey && event.key === "ArrowUp") return "previous-thread";
  if (event.altKey && !mod && !event.shiftKey && event.key === "ArrowDown") return "next-thread";
  if (!typing && !mod && !event.altKey && event.key === "?") return "help";
  return undefined;
}

export function adjacent<T>(items: readonly T[], current: T | undefined, step: number): T | undefined {
  if (items.length === 0) return undefined;
  const index = current === undefined ? -1 : items.indexOf(current);
  return items[(index + step + items.length) % items.length];
}

export function paletteMatches(commands: readonly { label: string; detail?: string }[], query: string): number[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return commands.flatMap((command, index) => {
    const text = `${command.label} ${command.detail ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word)) ? [index] : [];
  });
}
