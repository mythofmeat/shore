import { useSyncExternalStore } from "react";
import { parseRoute, SETTINGS_PAGES, type Route } from "./routing.ts";

export { SETTINGS_PAGES, type Route, type SettingsPage } from "./routing.ts";

let current = parseRoute(location.hash);
const listeners = new Set<() => void>();
addEventListener("hashchange", () => { current = parseRoute(location.hash); for (const listener of listeners) listener(); });

export function useRoute(): Route {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
}

export function navigate(route: Route): void {
  const hash = route.view === "chat" ? "" : `#settings/${route.page}`;
  if (route.view === "settings") { try { localStorage.setItem(LAST_PAGE_KEY, route.page); } catch { void 0; } }
  if (location.hash === hash || (hash === "" && location.hash === "")) return;
  if (hash === "") history.pushState(null, "", location.pathname + location.search);
  else history.pushState(null, "", hash);
  current = parseRoute(hash);
  for (const listener of listeners) listener();
}

const LAST_PAGE_KEY = "shore.settings-page";

export function openSettings(): void {
  let stored: string | null = null;
  try { stored = localStorage.getItem(LAST_PAGE_KEY); } catch { stored = null; }
  navigate({ view: "settings", page: SETTINGS_PAGES.find((item) => item.id === stored)?.id ?? "models" });
}
