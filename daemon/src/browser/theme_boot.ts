import { applyTheme, storedTheme } from "./theme.ts";

let storage: Storage | undefined;
try { storage = localStorage; } catch { storage = undefined; }
applyTheme(storedTheme(storage), document.documentElement);
