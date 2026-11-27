import { useEffect, useRef } from "react";
import { required } from "../../util/required.ts";
import { perform, workspace } from "./state.ts";

export interface ThreadPlace { character: string; thread: string }

export function threadPath(character: string, thread: string | null): string {
  return `/workspace/${encodeURIComponent(character)}/${encodeURIComponent(thread ?? "main")}`;
}

export function threadInPath(path: string): ThreadPlace | undefined {
  const match = /^\/workspace\/([^/]+)\/([^/]+)$/.exec(path);
  if (match === null) return undefined;
  return { character: decodeURIComponent(required(match[1])), thread: decodeURIComponent(required(match[2])) };
}

async function openPlace(place: ThreadPlace): Promise<void> {
  if (place.character !== workspace.getSnapshot().character) await workspace.openCharacter(place.character);
  if (place.thread !== (workspace.getSnapshot().thread ?? "main")) await workspace.openThread(place.thread);
}

export function useThreadUrl(character: string | null, thread: string | null): void {
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (character === null) return;
    const path = threadPath(character, thread);
    const switched = shown.current === location.pathname;
    shown.current = path;
    if (location.pathname === path) return;
    if (switched) history.pushState(null, "", path + location.hash);
    else history.replaceState(history.state, "", path + location.hash);
  }, [character, thread]);
  useEffect(() => {
    const moved = () => {
      const place = threadInPath(location.pathname);
      if (place !== undefined && threadPath(place.character, place.thread) !== shown.current) perform(() => openPlace(place));
    };
    addEventListener("popstate", moved);
    return () => { removeEventListener("popstate", moved); };
  }, []);
}
