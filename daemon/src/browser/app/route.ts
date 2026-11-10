import { useSyncExternalStore } from "react";
import { parseRoute, SETTINGS_PAGES, type Route } from "./routing.ts";
import { readStored, writeStored } from "../stored.ts";

export { SETTINGS_PAGES, type Route, type SettingsPage } from "./routing.ts";

let current = parseRoute(location.hash);
const listeners = new Set<() => void>();
addEventListener("hashchange", () => { current = parseRoute(location.hash); for (const listener of listeners) listener(); });

export function subscribeRoute(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeRoute, () => current);
}

export function navigate(route: Route): void {
  const hash = route.view === "chat" ? "" : `#settings/${route.page}`;
  if (route.view === "settings") writeStored(LAST_PAGE_KEY, route.page);
  if (location.hash === hash || (hash === "" && location.hash === "")) return;
  if (hash === "") history.pushState(null, "", location.pathname + location.search);
  else history.pushState(null, "", hash);
  current = parseRoute(hash);
  for (const listener of listeners) listener();
}

export const LAST_PAGE_KEY = "shore.settings-page";

export function openSettings(): void {
  const stored = readStored(LAST_PAGE_KEY);
  navigate({ view: "settings", page: SETTINGS_PAGES.find((item) => item.id === stored)?.id ?? "models" });
}
