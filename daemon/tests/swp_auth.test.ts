/**
 * The token, and the handshake check that is now the only way in.
 *
 * There is no IP allowlist behind this and no flag that turns it off, so these
 * tests are the whole of what stands between a reachable port and a full
 * session. Three properties matter and each fails silently if it regresses:
 *
 * - **Nothing is revealed before the check.** A rejected client must not learn
 *   the conversation, the config, or even that a character exists beyond the
 *   names in the server hello it already had.
 * - **A rejected client is *told*, in words it can act on.** The failure that
 *   costs an evening is the one that looks like a network problem.
 * - **A daemon that cannot hold a token does not listen.** Never "auth
 *   disabled" — that is the `allowed_hosts = []` trap wearing new clothes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveDaemonToken,
  tokenMatches,
  TokenError,
  TOKEN_ENV,
  TOKEN_FILE,
} from "../src/config/token.ts";
import { Server } from "../src/swp/server.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  // Drained before running, and each one isolated: a cleanup that throws must
  // not strand the ones after it in the array, where they would fire against
  // the *next* test's state and cascade. One test here deliberately makes a
  // directory unreadable, so a throwing cleanup is a real possibility.
  const pending = cleanups.splice(0).reverse();
  for (const c of pending) {
    try {
      c();
    } catch {
      // Best-effort: this is temp-directory teardown, not an assertion.
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shore-token-"));
  // Restored to something removable first — `reverse()` above means the last
  // registered cleanup runs first, so a mode change made after this line is
  // undone before the removal.
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("resolving the daemon's token", () => {
  test("the environment wins, and nothing is written", () => {
    const dir = tempDir();
    const got = resolveDaemonToken({ [TOKEN_ENV]: "from-env" }, dir);
    expect(got).toEqual({ token: "from-env", source: "env" });
    // A compose stack supplies the secret; the daemon must not also mint one
    // and leave a stale file that a local client would prefer later.
    expect(() => statSync(join(dir, TOKEN_FILE))).toThrow();
  });

  test("an existing file is used as-is, trimmed", () => {
    const dir = tempDir();
    writeFileSync(join(dir, TOKEN_FILE), "  on-disk\n\n");
    const got = resolveDaemonToken({}, dir);
    expect(got.token).toBe("on-disk");
    expect(got.source).toBe("file");
  });

  test("with neither, one is generated at 0600", () => {
    const dir = tempDir();
    const got = resolveDaemonToken({}, dir);
    expect(got.source).toBe("generated");
    // 256 bits, hex. Long enough that the timing-safe compare is the least
    // interesting part of the security story.
    expect(got.token).toMatch(/^[0-9a-f]{64}$/);

    const path = join(dir, TOKEN_FILE);
    expect(readFileSync(path, "utf8").trim()).toBe(got.token);
    // The mode is the reason a local client can read this and another account
    // on the same box cannot. `writeFileSync`'s mode is umask-masked, so this
    // asserts the explicit chmod actually happened.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a generated token is stable across restarts", () => {
    const dir = tempDir();
    const first = resolveDaemonToken({}, dir);
    const second = resolveDaemonToken({}, dir);
    expect(second.token).toBe(first.token);
    expect(second.source).toBe("file");
  });

  test("an empty SHORE_TOKEN means unset, not an empty secret", () => {
    // What an unset variable in a compose `.env` expands to. Treating it as a
    // real credential would send an empty token and reject every client with a
    // message pointing at the wrong thing.
    const dir = tempDir();
    writeFileSync(join(dir, TOKEN_FILE), "on-disk");
    expect(resolveDaemonToken({ [TOKEN_ENV]: "" }, dir).token).toBe("on-disk");
    expect(resolveDaemonToken({ [TOKEN_ENV]: "   " }, dir).token).toBe("on-disk");
  });

  test("an unwritable config directory refuses, and never falls back to open", () => {
    const dir = tempDir();
    chmodSync(dir, 0o500);
    cleanups.push(() => chmodSync(dir, 0o700));

    expect(() => resolveDaemonToken({}, dir)).toThrow(TokenError);
    try {
      resolveDaemonToken({}, dir);
    } catch (e) {
      // The message has to carry the way out, because this fires at startup on
      // a machine whose owner is looking at a container that will not boot.
      expect(String(e)).toContain(TOKEN_ENV);
    }
  });
});

describe("comparing", () => {
  test("matches only the exact token", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "ab")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
  });

  test("a missing or blank token never matches", () => {
    expect(tokenMatches("abc", undefined)).toBe(false);
    expect(tokenMatches("abc", null)).toBe(false);
    expect(tokenMatches("abc", "")).toBe(false);
    expect(tokenMatches("abc", "   ")).toBe(false);
  });

  test("surrounding whitespace is not part of the secret", () => {
    // `docker exec cat token` into a shell variable keeps the newline.
    expect(tokenMatches("abc", " abc\n")).toBe(true);
  });
});

/** Hand-write a hello with this token and report the frames that come back. */
async function helloWith(
  port: number,
  token: string | undefined,
): Promise<Record<string, unknown>[]> {
  const socket = connect({ host: "127.0.0.1", port, noDelay: true });
  const frames: Record<string, unknown>[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const done = new Promise<void>((resolve) => {
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        for (;;) {
          const at = buffered.indexOf("\n");
          if (at === -1) break;
          frames.push(JSON.parse(buffered.slice(0, at)) as Record<string, unknown>);
          buffered = buffered.slice(at + 1);
        }
      });
      socket.once("close", () => resolve());
      socket.once("error", () => resolve());
    });
    socket.write(
      `${JSON.stringify({
        type: "hello",
        client_type: "tui",
        client_name: "test",
        capabilities: [],
        ...(token === undefined ? {} : { token }),
      })}\n`,
    );
    // The daemon closes on refusal; a success is bounded by the history frame.
    await Promise.race([done, waitFor(() => frames.some((f) => f.type === "history"))]);
    return frames;
  } finally {
    socket.destroy();
  }
}

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A listening server whose only accepted token is `secret`. */
async function serving(): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = new Server({
    addr: "127.0.0.1:0",
    serverName: "shore-test",
    authenticate: (presented) => tokenMatches("secret", presented),
  });
  const { port } = await server.bind();
  const running = server.serve();
  return {
    port,
    stop: async () => {
      server.stop();
      await running;
    },
  };
}

describe("the handshake", () => {
  test("the right token gets a session", async () => {
    const { port, stop } = await serving();
    try {
      const frames = await helloWith(port, "secret");
      expect(frames.map((f) => f.type)).toEqual(["hello", "history"]);
    } finally {
      await stop();
    }
  });

  test("a wrong token gets an unauthorized error and no history", async () => {
    const { port, stop } = await serving();
    try {
      const frames = await helloWith(port, "wrong");
      const types = frames.map((f) => f.type);
      expect(types).toContain("error");
      // The refusal must not leak the conversation, the config, or the
      // selected character — everything of value rides on `history`.
      expect(types).not.toContain("history");

      const error = frames.find((f) => f.type === "error");
      expect(error?.code).toBe("unauthorized");
      expect(String(error?.message)).toContain(TOKEN_ENV);
    } finally {
      await stop();
    }
  });

  test("no token at all is refused, and told which case it is", async () => {
    const { port, stop } = await serving();
    try {
      const frames = await helloWith(port, undefined);
      const error = frames.find((f) => f.type === "error");
      expect(error?.code).toBe("unauthorized");
      // Distinct wording from the wrong-token case: "you sent none" and "yours
      // was rejected" send a person to different places.
      expect(String(error?.message)).toContain("sent no token");
      expect(frames.map((f) => f.type)).not.toContain("history");
    } finally {
      await stop();
    }
  });

  test("an empty token is refused like a missing one", async () => {
    const { port, stop } = await serving();
    try {
      const frames = await helloWith(port, "");
      expect(frames.find((f) => f.type === "error")?.code).toBe("unauthorized");
      expect(frames.map((f) => f.type)).not.toContain("history");
    } finally {
      await stop();
    }
  });
});
