export const SETTINGS_PAGES = [
  { id: "models", label: "Models", group: "Chat" },
  { id: "characters", label: "Characters", group: "Chat" },
  { id: "appearance", label: "Appearance", group: "Chat" },
  { id: "keyboard", label: "Keyboard shortcuts", group: "Chat" },
  { id: "providers", label: "Providers", group: "Daemon" },
  { id: "usage", label: "Usage & budgets", group: "Daemon" },
  { id: "configuration", label: "Configuration", group: "Daemon" },
  { id: "devices", label: "Devices", group: "Daemon" },
  { id: "memory", label: "Memory & segments", group: "Advanced" },
  { id: "diagnostics", label: "Diagnostics", group: "Advanced" },
  { id: "traces", label: "Traces & call log", group: "Advanced" },
  { id: "tools", label: "Tool runner", group: "Advanced" },
  { id: "archives", label: "Character archives", group: "Advanced" },
  { id: "debug", label: "Debug", group: "Advanced" },
] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number]["id"];
export type Route = { view: "chat" } | { view: "settings"; page: SettingsPage };

export function parseRoute(hash: string): Route {
  const match = /^#settings(?:\/([a-z]+))?$/.exec(hash);
  if (match === null) return { view: "chat" };
  const page = SETTINGS_PAGES.find((item) => item.id === match[1])?.id ?? "models";
  return { view: "settings", page };
}

