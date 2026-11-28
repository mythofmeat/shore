import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WebSession } from "./auth.ts";
import { sessionDigest } from "./recovery.ts";

export const DEVICES_FILE = "devices.json";
const LAST_USED_WRITE_MS = 60_000;

export type DeviceKind = "cli" | "automation";

export interface Device {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | undefined;
  readonly operations: readonly string[] | undefined;
}

interface StoredDevice {
  id: string;
  kind: DeviceKind;
  name: string;
  created_at: number;
  last_used_at?: number;
  digest: string;
  operations?: string[];
}

export type Principal =
  | { readonly kind: "browser"; readonly session: WebSession }
  | { readonly kind: "device"; readonly device: Device };

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return header === null ? undefined : /^Bearer +(\S+) *$/i.exec(header)?.[1];
}

export function principalOwner(principal: Principal): string {
  return principal.kind === "browser" ? principal.session.id : principal.device.id;
}

export function principalName(principal: Principal): string {
  return principal.kind === "browser" ? principal.session.name : principal.device.name;
}

export const DEVICE_NAME_RULE = "Give the device a name of 1 to 64 characters, without control characters";

export function deviceName(raw: string): string | undefined {
  const name = raw.trim();
  if (name === "" || name.length > 64 || Array.from(name, (character) => character.charCodeAt(0)).some((code) => code < 32 || code === 127)) return undefined;
  return name;
}

function isStored(value: unknown): value is StoredDevice {
  if (typeof value !== "object" || value === null) return false;
  const device = value as Record<string, unknown>;
  return typeof device["id"] === "string" && (device["kind"] === "cli" || device["kind"] === "automation") &&
    typeof device["name"] === "string" && Number.isSafeInteger(device["created_at"]) && typeof device["digest"] === "string" &&
    (device["last_used_at"] === undefined || Number.isSafeInteger(device["last_used_at"])) &&
    (device["operations"] === undefined || (Array.isArray(device["operations"]) && device["operations"].every((name) => typeof name === "string")));
}

function readDevices(path: string): StoredDevice[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  const devices = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["devices"] : undefined;
  if (!Array.isArray(devices) || !devices.every(isStored)) throw new Error(`${path} does not hold Shore's device sign-ins`);
  return devices;
}

function view(device: StoredDevice): Device {
  return {
    id: device.id, kind: device.kind, name: device.name, createdAt: device.created_at, lastUsedAt: device.last_used_at,
    operations: device.operations === undefined ? undefined : [...device.operations],
  };
}

export class DeviceStore {
  readonly path: string;
  readonly #devices: StoredDevice[];
  readonly #written = new Map<string, number | undefined>();

  constructor(dataDir: string) {
    this.path = join(dataDir, DEVICES_FILE);
    this.#devices = readDevices(this.path);
    for (const device of this.#devices) this.#written.set(device.id, device.last_used_at);
  }

  list(): Device[] { return this.#devices.map(view); }

  authenticate(token: string, now = Date.now()): Device | undefined {
    const digest = sessionDigest(token);
    const device = this.#devices.find((candidate) => candidate.digest === digest);
    if (device === undefined) return undefined;
    device.last_used_at = now;
    if (now - (this.#written.get(device.id) ?? 0) >= LAST_USED_WRITE_MS) this.#save();
    return view(device);
  }

  create(kind: DeviceKind, name: string, operations?: readonly string[], now = Date.now()): { device: Device; token: string } {
    const token = `shore_${randomBytes(32).toString("base64url")}`;
    const device: StoredDevice = {
      id: crypto.randomUUID(), kind, name, created_at: now, digest: sessionDigest(token),
      ...(operations === undefined ? {} : { operations: [...new Set(operations)].sort() }),
    };
    this.#devices.push(device);
    try { this.#save(); } catch (error) { this.#devices.pop(); throw error; }
    return { device: view(device), token };
  }

  revoke(id: string): boolean {
    const at = this.#devices.findIndex((device) => device.id === id);
    if (at === -1) return false;
    const [removed] = this.#devices.splice(at, 1);
    try { this.#save(); } catch (error) { if (removed !== undefined) this.#devices.splice(at, 0, removed); throw error; }
    return true;
  }

  #save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, devices: this.#devices }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    for (const device of this.#devices) this.#written.set(device.id, device.last_used_at);
  }
}
