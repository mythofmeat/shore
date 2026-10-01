import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseAddress } from "./address.ts";

export interface WindowState { width: number; height: number; maximized: boolean }
export interface Settings { address: string | null; closeToTray: boolean; zoom: number; window: WindowState }

export const DEFAULT_SETTINGS: Settings = { address: null, closeToTray: true, zoom: 0, window: { width: 1200, height: 820, maximized: false } };
export const ZOOM_LIMIT = 6;

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 200 && value <= 16384 ? value : fallback;
}

export function parseSettings(text: string): Settings {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return DEFAULT_SETTINGS; }
  const value = fields(raw);
  const window = fields(value["window"]);
  const address = typeof value["address"] === "string" ? parseAddress(value["address"]) : undefined;
  const zoom = value["zoom"];
  return {
    address: address?.ok === true ? address.origin : null,
    closeToTray: typeof value["closeToTray"] === "boolean" ? value["closeToTray"] : DEFAULT_SETTINGS.closeToTray,
    zoom: typeof zoom === "number" && Number.isFinite(zoom) && Math.abs(zoom) <= ZOOM_LIMIT ? zoom : 0,
    window: {
      width: dimension(window["width"], DEFAULT_SETTINGS.window.width),
      height: dimension(window["height"], DEFAULT_SETTINGS.window.height),
      maximized: window["maximized"] === true,
    },
  };
}

export function readSettings(path: string): Settings {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return DEFAULT_SETTINGS; }
  return parseSettings(text);
}

export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
