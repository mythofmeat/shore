import { applyFontSize, storedFontSize } from "./font_size.ts";
import { applyTheme, storedTheme } from "./theme.ts";

let storage: Storage | undefined;
try { storage = localStorage; } catch { storage = undefined; }
applyTheme(storedTheme(storage), document.documentElement);
applyFontSize(storedFontSize(storage), document.documentElement);
