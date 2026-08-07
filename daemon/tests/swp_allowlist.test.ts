/**
 * `[daemon].allowed_hosts` — CIDR matching, and the IPv4-mapped peer.
 *
 * The matching tests are unit-level because that is where the behaviour is.
 * The two socket tests exist for the part a unit test cannot claim: that the
 * address `#accept` is really handed matches what the config author wrote.
 * The dual-stack one is the whole reason this changed — bind `[::]`, connect
 * over IPv4, and the peer arrives as `::ffff:127.0.0.1`, which the old string
 * compare rejected against `allowed_hosts = ["127.0.0.1"]`.
 */

import { describe, expect, test } from "bun:test";
import { connect } from "node:net";

import { buildAllowlist, invalidAllowedHosts, parseAllowedHost } from "../src/swp/allowlist.ts";
import { validateRemoteAccessPolicy } from "../src/daemon/startup.ts";
import { Server } from "../src/swp/server.ts";

/** Accept any token; authentication is `swp_auth.test.ts`'s subject, not this
 *  file's. `authenticate` is required so that opting out is written down. */
const OPEN = (): boolean => true;


/** Whether a peer gets past an allowlist built from these entries. */
function allows(entries: readonly string[], peer: string): boolean {
  return buildAllowlist(entries)?.check(peer) ?? true;
}

describe("parsing", () => {
  test("bare addresses and CIDR ranges, both families", () => {
    expect(parseAllowedHost("10.0.0.5")).toEqual({ ok: true, ip: "10.0.0.5", family: "ipv4" });
    expect(parseAllowedHost("172.18.0.0/16")).toEqual({
      ok: true,
      ip: "172.18.0.0",
      family: "ipv4",
      prefix: 16,
    });
    expect(parseAllowedHost("fd00::1")).toEqual({ ok: true, ip: "fd00::1", family: "ipv6" });
    expect(parseAllowedHost("fd00::/8")).toEqual({
      ok: true,
      ip: "fd00::",
      family: "ipv6",
      prefix: 8,
    });
  });

  test("an IPv4-mapped entry collapses to its v4 form", () => {
    // BlockList normalizes mapped addresses on the peer side only, so a rule
    // written this way would otherwise be a v6 rule that a plain v4 peer never
    // matches. The two spellings name one host; they should behave as one.
    expect(parseAllowedHost("::ffff:10.0.0.5")).toEqual({
      ok: true,
      ip: "10.0.0.5",
      family: "ipv4",
    });
    expect(allows(["::ffff:10.0.0.5"], "10.0.0.5")).toBe(true);
  });

  test("prefix widths are checked per family", () => {
    expect(parseAllowedHost("10.0.0.0/33").ok).toBe(false);
    expect(parseAllowedHost("fd00::/129").ok).toBe(false);
    expect(parseAllowedHost("10.0.0.0/32").ok).toBe(true);
    expect(parseAllowedHost("fd00::/128").ok).toBe(true);
    expect(parseAllowedHost("10.0.0.0/8.5").ok).toBe(false);
    expect(parseAllowedHost("10.0.0.0/").ok).toBe(false);
  });

  test("garbage is reported, not thrown", () => {
    expect(parseAllowedHost("not-an-ip").ok).toBe(false);
    expect(parseAllowedHost("example.com").ok).toBe(false);
    expect(parseAllowedHost("").ok).toBe(false);
    expect(invalidAllowedHosts(["10.0.0.5", "nope", "10.0.0.0/99"]).map((e) => e.entry)).toEqual([
      "nope",
      "10.0.0.0/99",
    ]);
  });
});

describe("matching", () => {
  test("an empty list allows every peer", () => {
    expect(buildAllowlist([])).toBeNull();
    expect(allows([], "8.8.8.8")).toBe(true);
  });

  test("a CIDR range covers the addresses a bridge network hands out", () => {
    expect(allows(["172.18.0.0/16"], "172.18.0.2")).toBe(true);
    expect(allows(["172.18.0.0/16"], "172.18.255.254")).toBe(true);
    expect(allows(["172.18.0.0/16"], "172.19.0.2")).toBe(false);
  });

  test("an exact address still matches exactly", () => {
    expect(allows(["10.0.0.5"], "10.0.0.5")).toBe(true);
    expect(allows(["10.0.0.5"], "10.0.0.6")).toBe(false);
  });

  test("an IPv4-mapped peer matches an IPv4 rule", () => {
    // The latent bug this issue was really about.
    expect(allows(["127.0.0.1"], "::ffff:127.0.0.1")).toBe(true);
    expect(allows(["172.18.0.0/16"], "::ffff:172.18.0.2")).toBe(true);
    expect(allows(["172.18.0.0/16"], "::ffff:172.19.0.2")).toBe(false);
  });

  test("IPv6 ranges work on their own terms", () => {
    expect(allows(["fd00::/8"], "fd00::1")).toBe(true);
    expect(allows(["fd00::/8"], "fe80::1")).toBe(false);
    expect(allows(["::1"], "::1")).toBe(true);
  });

  test("a non-empty list of only-garbage rejects everyone", () => {
    // Fail closed. Falling back to "allow everything" would turn one typo into
    // an open port, which is the failure nobody would notice.
    expect(allows(["not-an-ip"], "127.0.0.1")).toBe(false);
    expect(allows(["10.0.0.5", "not-an-ip"], "10.0.0.5")).toBe(true);
    expect(allows(["10.0.0.5", "not-an-ip"], "10.0.0.6")).toBe(false);
  });

  test("an unparseable peer is rejected", () => {
    expect(allows(["127.0.0.1"], "")).toBe(false);
  });
});

describe("startup warnings", () => {
  test("a malformed entry warns even on a loopback bind", () => {
    const warnings = validateRemoteAccessPolicy("127.0.0.1:7320", false, ["10.0.0.0/99"]);
    expect(Array.isArray(warnings)).toBe(true);
    expect((warnings as string[]).join(" ")).toContain("10.0.0.0/99");
  });

  test("well-formed entries say nothing", () => {
    expect(validateRemoteAccessPolicy("127.0.0.1:7320", false, ["172.18.0.0/16"])).toEqual([]);
  });
});

/** Connect, and report whether the server hung up before answering. */
async function rejected(host: string, port: number): Promise<boolean> {
  const socket = connect({ host, port, noDelay: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `${JSON.stringify({ type: "hello", client_type: "tui", client_name: "t", capabilities: [] })}\n`,
    );
    return await new Promise<boolean>((resolve) => {
      socket.once("data", () => resolve(false));
      socket.once("close", () => resolve(true));
      socket.once("error", () => resolve(true));
    });
  } finally {
    socket.destroy();
  }
}

describe("over a socket", () => {
  test("a peer outside the range is hung up on, one inside is served", async () => {
    const server = new Server({
      addr: "127.0.0.1:0",
      serverName: "shore-test",
      allowedHosts: ["127.0.0.0/8"],
      authenticate: OPEN,
    });
    const { port } = await server.bind();
    const running = server.serve();
    try {
      expect(await rejected("127.0.0.1", port)).toBe(false);
    } finally {
      server.stop();
      await running;
    }

    const closed = new Server({
      addr: "127.0.0.1:0",
      serverName: "shore-test",
      allowedHosts: ["10.0.0.0/8"],
      authenticate: OPEN,
    });
    const { port: closedPort } = await closed.bind();
    const closedRunning = closed.serve();
    try {
      expect(await rejected("127.0.0.1", closedPort)).toBe(true);
    } finally {
      closed.stop();
      await closedRunning;
    }
  });

  test("a dual-stack listener serves an IPv4 peer named in v4", async () => {
    // `allowed_hosts = ["127.0.0.1"]` rejecting 127.0.0.1 was the bug. It only
    // reproduces on a v6 listener, which is exactly the bind allowed_hosts is
    // for.
    const server = new Server({
      addr: "[::]:0",
      serverName: "shore-test",
      allowedHosts: ["127.0.0.1"],
      authenticate: OPEN,
    });
    const { port } = await server.bind();
    const running = server.serve();
    try {
      expect(await rejected("127.0.0.1", port)).toBe(false);
    } finally {
      server.stop();
      await running;
    }
  });
});
