import type { SignInFlow } from "./claude_sign_in.ts";

const SIGN_IN_TTL_MS = 15 * 60_000;

const MAX_WAITING = 4;

export interface PendingSignIn<T> {
  provider: string;
  credential: string;
  flow: SignInFlow;
  expiresAt: number;
  detail: T;
}

interface Waiting extends PendingSignIn<unknown> {
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

const waiting = new Map<string, Waiting>();
const starting = new Map<string, Promise<Waiting>>();

function keyOf(provider: string, credential: string): string {
  return `${provider}\u0000${credential.toLowerCase()}`;
}

function drop(key: string): Waiting | undefined {
  const entry = waiting.get(key);
  if (entry === undefined) return undefined;
  waiting.delete(key);
  clearTimeout(entry.timer);
  return entry;
}

function end(entry: Waiting): void {
  entry.flow.close();
  entry.cleanup();
}

export async function beginSignIn<T>(
  provider: string,
  credential: string,
  start: () => Promise<{ flow: SignInFlow; detail: T }>,
  cleanup: (detail: T) => void,
  now: number = Date.now(),
): Promise<{ pending: PendingSignIn<T>; joined: boolean }> {
  const key = keyOf(provider, credential);
  const live = waiting.get(key);
  if (live !== undefined) return { pending: live as PendingSignIn<T>, joined: true };
  const begun = starting.get(key);
  if (begun !== undefined) return { pending: (await begun) as PendingSignIn<T>, joined: true };
  if (waiting.size + starting.size >= MAX_WAITING) {
    throw new Error(`${String(MAX_WAITING)} sign-ins are already waiting for their codes; finish or cancel one first`);
  }
  const opening = start().then(({ flow, detail }) => {
    const entry: Waiting = {
      provider, credential, flow, detail, expiresAt: now + SIGN_IN_TTL_MS,
      cleanup: () => cleanup(detail),
      timer: setTimeout(() => {
        const expired = drop(key);
        if (expired !== undefined) end(expired);
      }, SIGN_IN_TTL_MS),
    };
    entry.timer.unref();
    waiting.set(key, entry);
    return entry;
  }).finally(() => starting.delete(key));
  starting.set(key, opening);
  return { pending: (await opening) as PendingSignIn<T>, joined: false };
}

export function pendingSignIn<T>(provider: string, credential: string): PendingSignIn<T> | undefined {
  return waiting.get(keyOf(provider, credential)) as PendingSignIn<T> | undefined;
}

export function takeSignIn<T>(provider: string, credential: string): (PendingSignIn<T> & { cleanup: () => void }) | undefined {
  const entry = drop(keyOf(provider, credential));
  return entry === undefined ? undefined : (entry as PendingSignIn<T> & { cleanup: () => void });
}

export function cancelSignIn(provider: string, credential: string): boolean {
  const entry = drop(keyOf(provider, credential));
  if (entry === undefined) return false;
  end(entry);
  return true;
}

export function closeSignIns(): void {
  for (const key of waiting.keys()) {
    const entry = drop(key);
    if (entry !== undefined) end(entry);
  }
}

export interface PastedCode {
  code: string;
  state: string;
}

export function readPastedCode(raw: string): PastedCode | undefined {
  const pasted = raw.trim();
  if (/^https?:\/\//i.test(pasted)) {
    try {
      const url = new URL(pasted);
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      return code === "" || state === "" ? undefined : { code, state };
    } catch {
      return undefined;
    }
  }
  const [code = "", state = "", ...rest] = pasted.split("#");
  if (code === "" || state === "" || rest.length > 0 || /\s/.test(pasted)) return undefined;
  return { code, state };
}
