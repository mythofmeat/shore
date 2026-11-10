import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { readStored, writeStored } from "../stored.ts";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    const list = matchMedia(query);
    list.addEventListener("change", listener);
    return () => list.removeEventListener("change", listener);
  }, [query]);
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}

export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => { const stored = readStored(key); return stored === null ? fallback : stored === "true"; });
  const update = useCallback((next: boolean) => { setValue(next); writeStored(key, String(next)); }, [key]);
  return [value, update];
}

export function useStoredText(key: string, fallback: () => string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => readStored(key) ?? fallback());
  const update = useCallback((next: string) => { setValue(next); writeStored(key, next); }, [key]);
  return [value, update];
}

export function useEscape(active: boolean, action: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && document.querySelector("dialog[open]") === null) action(); };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, [active, action]);
}
