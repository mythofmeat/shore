import { applyFontSize, storedFontSize } from "./font_size.ts";
import { applyTheme, storedTheme } from "./theme.ts";

function pageStorage(): Storage | undefined {
  try { return localStorage; } catch { return undefined; }
}

const storage = pageStorage();
applyTheme(storedTheme(storage), document.documentElement);
applyFontSize(storedFontSize(storage), document.documentElement);
