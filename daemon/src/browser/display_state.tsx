import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { DisplayPreferences, PREFERENCE_STORAGE_KEY } from "./preferences.ts";

const DisplayContext = createContext<DisplayPreferences | null>(null);

export function DisplayProvider({ children }: { children: ReactNode }) {
  const [preferences] = useState(() => new DisplayPreferences({ getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }));
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(`${PREFERENCE_STORAGE_KEY}.`)) preferences.reload(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [preferences]);
  return <DisplayContext.Provider value={preferences}>{children}</DisplayContext.Provider>;
}

export function useDisplay(): DisplayPreferences {
  const preferences = useContext(DisplayContext);
  if (preferences === null) throw new Error("Display preferences need a provider");
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  return preferences;
}
