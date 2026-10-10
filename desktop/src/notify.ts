export const OSASCRIPT = "/usr/bin/osascript";

// macOS only lets apps signed with an Apple Developer ID post their own notifications, and Shore.app is signed ad hoc,
// so AppleScript posts them instead. The text goes in as arguments, never as script source, so nothing in it can run.
export function notificationArgs(title: string, body: string): string[] {
  return ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body];
}

export function dockBadge(unread: number): string {
  return unread > 0 ? String(unread) : "";
}
