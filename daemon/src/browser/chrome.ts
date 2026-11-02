import type { ChromeSnapshot, WorkspaceSnapshot } from "./workspace.ts";

export function chromeOf(previous: ChromeSnapshot | undefined, full: WorkspaceSnapshot): ChromeSnapshot {
  const { messages: _messages, metadata: _metadata, streams: _streams, media: _media, mediaLimited: _mediaLimited, activity: _activity, ...next } = full;
  if (previous === undefined) return next;
  return (Object.keys(next) as (keyof ChromeSnapshot)[]).some((key) => next[key] !== previous[key]) ? next : previous;
}
