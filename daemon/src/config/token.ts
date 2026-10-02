import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { rustJoin, type Env } from "./dirs.ts";

export const TOKEN_ENV = "SHORE_TOKEN";

export const TOKEN_FILE = "token";

const TOKEN_BYTES = 32;

export class TokenError extends Error {
  override readonly name = "TokenError";
}

type TokenSource = "env" | "file" | "generated";

export interface ResolvedToken {
  readonly token: string;
  readonly source: TokenSource;
  readonly path?: string;
}

export function resolveDaemonToken(env: Env, configDir: string): ResolvedToken {
  const fromEnv = nonBlank(env[TOKEN_ENV]);
  if (fromEnv !== undefined) return { token: fromEnv, source: "env" };

  const path = rustJoin(configDir, TOKEN_FILE);
  const fromFile = nonBlank(readOrUndefined(path));
  if (fromFile !== undefined) return { token: fromFile, source: "file", path };

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (e) {
    throw new TokenError(
      `shore has no token and could not create one at ${path}: ${String(e)}. ` +
        `Set $${TOKEN_ENV} instead, or make the config directory writable.`,
    );
  }
  return { token, source: "generated", path };
}

export function tokenMatches(expected: string, presented: string | null | undefined): boolean {
  const given = nonBlank(presented ?? undefined);
  if (given === undefined) return false;
  return timingSafeEqual(sha256(expected), sha256(given));
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

function nonBlank(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
