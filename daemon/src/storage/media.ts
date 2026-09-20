import { join } from "node:path";

export const characterMediaDir = (data: string, character: string): string => join(data, "media", character);
