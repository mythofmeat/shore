import { useEffect, useRef } from "react";
import { required } from "../../util/required.ts";
import { openThreadIn, perform } from "./state.ts";
import { toasts } from "../ui/toast.tsx";
import { noteVisit } from "./recent.ts";

export interface ThreadPlace { character: string; thread: string }

export function threadPath(character: string, thread: string | null): string {
  return `/workspace/${encodeURIComponent(character)}/${encodeURIComponent(thread ?? "main")}`;
}

export function threadInPath(path: string): ThreadPlace | undefined {
  const match = /^\/workspace\/([^/]+)\/([^/]+)$/.exec(path);
  if (match === null) return undefined;
  return { character: decodeURIComponent(required(match[1])), thread: decodeURIComponent(required(match[2])) };
}

function sayWhatIsMissing(asked: ThreadPlace | undefined, character: string, thread: string | null): void {
  if (asked === undefined) return;
  toasts.show(asked.character === character ? `${character} has no thread “${asked.thread}”, so this is ${thread ?? "main"}` : `There is no character “${asked.character}”, so this is ${character}`, "error");
}

export function useThreadUrl(character: string | null, thread: string | null): void {
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (character === null) return;
    noteVisit(character, thread ?? "main");
    const path = threadPath(character, thread);
    const first = shown.current === null;
    const switched = shown.current === location.pathname;
    shown.current = path;
    if (location.pathname === path) return;
    if (first) sayWhatIsMissing(threadInPath(location.pathname), character, thread);
    if (switched) history.pushState(null, "", path + location.hash);
    else history.replaceState(history.state, "", path + location.hash);
  }, [character, thread]);
  useEffect(() => {
    const moved = () => {
      const place = threadInPath(location.pathname);
      if (place !== undefined && threadPath(place.character, place.thread) !== shown.current) perform(() => openThreadIn(place.character, place.thread));
    };
    addEventListener("popstate", moved);
    return () => { removeEventListener("popstate", moved); };
  }, []);
}
