export interface Shortcut { keys: string[]; description: string; where: "Anywhere" | "Message box" | "Conversation" }

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ["Mod", "K"], description: "Open the command palette", where: "Anywhere" },
  { keys: ["Mod", "/"], description: "Focus the message box", where: "Anywhere" },
  { keys: ["Mod", "Shift", "O"], description: "New conversation", where: "Anywhere" },
  { keys: ["Alt", "↑ / ↓"], description: "Previous or next conversation", where: "Anywhere" },
  { keys: ["Alt", "Shift", "↓"], description: "Next conversation with unread messages", where: "Anywhere" },
  { keys: ["Mod", "\\"], description: "Show or hide the sidebar", where: "Anywhere" },
  { keys: ["Mod", ","], description: "Open settings", where: "Anywhere" },
  { keys: ["?"], description: "Show keyboard shortcuts", where: "Anywhere" },
  { keys: ["Enter"], description: "Send (Shift+Enter for a new line)", where: "Message box" },
  { keys: ["↑"], description: "Edit your last message when the box is empty", where: "Message box" },
  { keys: ["← / →"], description: "Previous or next response when the box is empty", where: "Message box" },
  { keys: ["Esc"], description: "Stop a response, or move focus to the conversation", where: "Message box" },
  { keys: ["↑ ↓ PgUp PgDn Home End"], description: "Scroll the conversation", where: "Conversation" },
];

const MOD_ENTER_SENDS: Shortcut = { keys: ["Mod", "Enter"], description: "Send (Enter for a new line)", where: "Message box" };

const VIM_COMPOSER: Readonly<Record<string, string>> = {
  "Send (Shift+Enter for a new line)": "Send in insert mode (Shift+Enter for a new line)",
  "Send (Enter for a new line)": "Send from any mode (Enter adds a new line in insert mode)",
  "Edit your last message when the box is empty": "Edit your last message when the box is empty, in insert mode",
  "Previous or next response when the box is empty": "Previous or next response when the box is empty, in insert mode",
  "Stop a response, or move focus to the conversation": "Switch to normal mode (Stop ends a response)",
};

export function shortcutsFor(enterSends: boolean, vim = false): readonly Shortcut[] {
  const shortcuts = enterSends ? SHORTCUTS : SHORTCUTS.map((item) => item.keys.length === 1 && item.keys[0] === "Enter" ? MOD_ENTER_SENDS : item);
  return vim ? shortcuts.map((item) => item.where === "Message box" ? { ...item, description: VIM_COMPOSER[item.description] ?? item.description } : item) : shortcuts;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function keyLabel(key: string): string {
  return key === "Mod" ? IS_MAC ? "⌘" : "Ctrl" : key;
}

export type GlobalAction = "palette" | "focus" | "new-thread" | "previous-thread" | "next-thread" | "next-unread-thread" | "sidebar" | "settings" | "help";

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
  if (event.altKey && !mod && event.shiftKey && event.key === "ArrowDown") return "next-unread-thread";
  if (!typing && !mod && !event.altKey && event.key === "?") return "help";
  return undefined;
}

export function nextUnread(threads: readonly { id: string; unread?: number }[], current: string | null): string | undefined {
  const start = threads.findIndex((thread) => thread.id === current);
  for (let step = 1; step <= threads.length; step += 1) {
    const thread = threads[(start + step + threads.length) % threads.length];
    if (thread !== undefined && thread.id !== current && (thread.unread ?? 0) > 0) return thread.id;
  }
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
