/**
 * The shared secret every SWP client presents, and where it comes from.
 *
 * The TypeScript counterpart of `client/shore-common/src/token.rs`. The two
 * must agree on the resolution order and on the file's name, because they are
 * the two halves of one credential — and, as with {@link resolveShoreDirs}, a
 * client has to find it *before* it has a daemon to ask.
 *
 * # Why a token, and why only a token
 *
 * SWP carries no authentication of its own, and passing the connection check
 * grants a full session: every character's history, the ability to send as the
 * user, and the whole tool surface. The check is all-or-nothing, so the only
 * question is what it should be.
 *
 * It used to be an IP allowlist plus `unsafe_allow_remote_access`, a flag that
 * asked you to acknowledge the exposure rather than remove it. Both are gone:
 *
 * - **An address is not a credential.** A container bridge hands out addresses
 *   from ranges indistinguishable from an ordinary LAN's, so "allow my
 *   containers" and "allow my whole network" were the same configuration.
 * - **A flag that asks you to accept a risk is worse than not having the
 *   risk.** Being safe used to require getting the bind address, the flag and
 *   the allowlist all right at once. Now there is nothing to get right: the
 *   daemon is closed wherever it is bound.
 *
 * One mechanism, always on, no opt-out. A daemon that cannot establish a token
 * does not start.
 *
 * # This side owns the secret
 *
 * The daemon writes; clients only read (`token.rs` has no generator at all). A
 * client that minted its own credential would not be authenticating.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { rustJoin, type Env } from "./dirs.ts";

/**
 * Environment override, and the way a client on another host or in another
 * container is told the secret.
 *
 * Checked before the file so a compose stack can put one value in `.env` and
 * hand it to the daemon and every client together — no shared volume, nothing
 * to regenerate, and rotation is editing one line.
 */
export const TOKEN_ENV = "SHORE_TOKEN";

/** The generated file, under the config directory beside `config.toml`. */
export const TOKEN_FILE = "token";

/** Bytes of entropy in a generated token. 256 bits, hex-encoded. */
const TOKEN_BYTES = 32;

/** Raised when no token can be resolved *or* created. */
export class TokenError extends Error {
  override readonly name = "TokenError";
}

/** Where a resolved token came from, for the startup log line. */
export type TokenSource = "env" | "file" | "generated";

export interface ResolvedToken {
  readonly token: string;
  readonly source: TokenSource;
  /** The file path, for `file` and `generated`. */
  readonly path?: string;
}

/**
 * The daemon's token: `$SHORE_TOKEN`, else `<config>/token`, else a fresh one
 * written to `<config>/token` at mode 0600.
 *
 * Generation is what makes this invisible on a single machine: the daemon
 * writes the file, and a client on the same box resolves the same config
 * directory and reads it. Nobody types a token to run shore locally.
 *
 * @throws {TokenError} when there is no token and none can be written. That is
 * a refusal to start, deliberately, and never a fallback to "authentication
 * off" — a read-only `/config` should stop the daemon, not silently open it.
 */
export function resolveDaemonToken(env: Env, configDir: string): ResolvedToken {
  const fromEnv = nonBlank(env[TOKEN_ENV]);
  if (fromEnv !== undefined) return { token: fromEnv, source: "env" };

  const path = rustJoin(configDir, TOKEN_FILE);
  const fromFile = nonBlank(readOrUndefined(path));
  if (fromFile !== undefined) return { token: fromFile, source: "file", path };

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  try {
    mkdirSync(configDir, { recursive: true });
    // `mode` on `writeFileSync` is masked by the umask, so the file could land
    // world-readable on a permissive one. The explicit `chmod` afterwards is
    // what actually guarantees 0600 — and 0600 is the whole reason a local
    // client can read this file while another account on the box cannot.
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

/**
 * Whether a client's hello carries the right token.
 *
 * Compared as SHA-256 digests rather than as strings. That is not about
 * hashing the secret — both sides already hold it in the clear — it is to get
 * two buffers of *equal length*, because `timingSafeEqual` throws on a length
 * mismatch and returning early on one would leak the length through timing.
 *
 * The timing channel is not a realistic threat against a 256-bit secret over a
 * LAN. But `===` on a secret is the kind of thing that is only ever wrong, and
 * doing it properly costs one function.
 */
export function tokenMatches(expected: string, presented: string | null | undefined): boolean {
  const given = nonBlank(presented ?? undefined);
  if (given === undefined) return false;
  return timingSafeEqual(sha256(expected), sha256(given));
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * The value with surrounding whitespace removed, or `undefined` if nothing is
 * left.
 *
 * Two reasons this matters and neither is cosmetic. An editor or a
 * `docker exec cat` adds a trailing newline, and a token differing from the
 * daemon's by one byte fails with no clue why. And `SHORE_TOKEN=""` is what an
 * unset variable in a compose `.env` expands to — treating that as a real
 * (empty) secret would send an empty token rather than falling through to the
 * file.
 */
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
