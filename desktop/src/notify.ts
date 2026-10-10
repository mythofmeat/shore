export const OSASCRIPT = "/usr/bin/osascript";

export function notificationArgs(title: string, body: string): string[] {
  return ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body];
}

export function dockBadge(unread: number): string {
  return unread > 0 ? String(unread) : "";
}
