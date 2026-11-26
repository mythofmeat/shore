import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WebSignInPending } from "../protocol/WebSignInPending.ts";
import type { WebSignInRequest } from "../protocol/WebSignInRequest.ts";
import type { WebSession } from "./auth.ts";
import { sessionDigest } from "./recovery.ts";

export const DEVICES_FILE = "devices.json";
const LAST_USED_WRITE_MS = 60_000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

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
  | { readonly kind: "owner" }
  | { readonly kind: "device"; readonly device: Device };

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return header === null ? undefined : /^Bearer +(\S+) *$/i.exec(header)?.[1];
}

export function principalName(principal: Principal): string {
  if (principal.kind === "browser") return principal.session.name;
  return principal.kind === "device" ? principal.device.name : "The daemon's own token";
}

export class DeviceNameError extends Error {}

export function deviceName(raw: string): string {
  const name = raw.trim();
  if (name === "" || name.length > 64 || Array.from(name, (character) => character.charCodeAt(0)).some((code) => code < 32 || code === 127)) {
    throw new DeviceNameError("Give the device a name of 1 to 64 characters, without control characters");
  }
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
      id: crypto.randomUUID(), kind, name: deviceName(name), created_at: now, digest: sessionDigest(token),
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
    this.#written.delete(id);
    return true;
  }

  #save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, devices: this.#devices }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    for (const device of this.#devices) this.#written.set(device.id, device.last_used_at);
  }
}

interface PendingSignIn {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly secret: string;
  readonly expiresAt: number;
  decision?: boolean;
}

export type SignInState = "waiting" | "denied" | { readonly allowed: string };

export class SignInRequests {
  readonly #requests = new Map<string, PendingSignIn>();

  constructor(readonly lifetime: number, readonly capacity: number) {}

  #sweep(now: number): void {
    for (const [id, request] of this.#requests) if (request.expiresAt <= now) this.#requests.delete(id);
  }

  start(name: string, secret: string, now = Date.now()): WebSignInPending | undefined {
    this.#sweep(now);
    if (this.#requests.size >= this.capacity) return undefined;
    const taken = new Set([...this.#requests.values()].map((request) => request.code));
    let code: string;
    do code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    while (taken.has(code));
    const request: PendingSignIn = { id: crypto.randomUUID(), code, name: deviceName(name), secret: sessionDigest(secret), expiresAt: now + this.lifetime };
    this.#requests.set(request.id, request);
    return { id: request.id, code, expires_at: request.expiresAt };
  }

  pending(now = Date.now()): WebSignInRequest[] {
    this.#sweep(now);
    return [...this.#requests.values()].filter((request) => request.decision === undefined)
      .map((request) => ({ code: request.code, name: request.name, expires_at: request.expiresAt }));
  }

  decide(code: string, allow: boolean, now = Date.now()): boolean {
    this.#sweep(now);
    const request = [...this.#requests.values()].find((candidate) => candidate.code === code.trim().toUpperCase() && candidate.decision === undefined);
    if (request === undefined) return false;
    request.decision = allow;
    return true;
  }

  poll(id: string, secret: string, now = Date.now()): SignInState | undefined {
    this.#sweep(now);
    const request = this.#requests.get(id);
    if (request?.secret !== sessionDigest(secret)) return undefined;
    if (request.decision === undefined) return "waiting";
    this.#requests.delete(id);
    return request.decision ? { allowed: request.name } : "denied";
  }

  clear(): void { this.#requests.clear(); }
}
