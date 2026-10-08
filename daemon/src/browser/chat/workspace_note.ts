import type { WorkspaceRewind } from "../../protocol/WorkspaceRewind.ts";

export function workspaceNote(rewind: WorkspaceRewind | undefined): string | undefined {
  if (rewind === undefined) return undefined;
  if (rewind.kept === "later_turns") return "Workspace files kept: later turns build on this one";
  const files = (count: number): string => `${String(count)} workspace file${count === 1 ? "" : "s"}`;
  const restored = rewind.restored.length === 0 ? undefined : `Restored ${files(rewind.restored.length)}`;
  if (rewind.skipped.length === 0) return restored;
  const names = rewind.skipped.slice(0, 3).join(", ") + (rewind.skipped.length > 3 ? ", …" : "");
  const left = `${files(rewind.skipped.length)} changed since and ${rewind.skipped.length === 1 ? "was" : "were"} left as is: ${names}`;
  return restored === undefined ? left.charAt(0).toUpperCase() + left.slice(1) : `${restored}; ${left}`;
}
