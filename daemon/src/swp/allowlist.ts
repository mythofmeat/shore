/**
 * The peer-IP allowlist behind `[daemon].allowed_hosts`.
 *
 * This is not authentication and not transport security — see
 * {@link ServerConfig.allowedHosts}. It is a guard against casual exposure,
 * and it has to be able to express the shapes people actually deploy into.
 *
 * # Why this is not a string compare
 *
 * It was one, and it was wrong in two ways that show up together:
 *
 * - **A bridge network hands out addresses from a subnet** and does not
 *   promise which one a container gets, so an exact-match list cannot say
 *   "the containers on this network". Hence CIDR.
 * - **A dual-stack listener sees IPv4 peers as IPv4-mapped IPv6 addresses.**
 *   `socket.remoteAddress` is then `"::ffff:127.0.0.1"`, which no config file
 *   contains, so `allowed_hosts = ["127.0.0.1"]` rejected `127.0.0.1`. It went
 *   unnoticed because the default `addr` is a v4 listener; it starts mattering
 *   the moment someone binds `[::]` or `0.0.0.0`, which is the only situation
 *   this feature exists for.
 *
 * `node:net`'s {@link BlockList} answers both, and answers the second one for
 * free: it unwraps IPv4-mapped addresses against IPv4 rules. That is the whole
 * reason to use it rather than parse addresses here — v6 canonicalization is
 * exactly the kind of thing to not hand-roll.
 *
 * # Fail closed
 *
 * A non-empty `allowed_hosts` whose entries are *all* unparseable rejects
 * every peer. It does not fall back to allowing everyone. An operator who
 * typoed their allowlist gets a daemon nobody can reach, which they will
 * notice; the other way round they get a daemon everybody can reach, which
 * they will not.
 */

import { BlockList, isIPv4, isIPv6 } from "node:net";

/** A parsed `allowed_hosts` entry, or the reason it could not be parsed. */
type ParsedEntry =
  | { readonly ok: true; readonly ip: string; readonly family: "ipv4" | "ipv6"; readonly prefix?: number }
  | { readonly ok: false; readonly entry: string; readonly reason: string };

/**
 * An IPv4-mapped IPv6 literal written *in the config* reduced to its v4 form.
 *
 * `BlockList` normalizes mapped addresses on the peer side, not the rule side:
 * a rule added as `::ffff:10.0.0.1` is a v6 rule and a plain `10.0.0.1` peer
 * will not match it. Since the whole point here is that the two spellings name
 * one host, collapse them before they become rules.
 */
function unmapIPv4(entry: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(entry);
  return mapped?.[1] !== undefined && isIPv4(mapped[1]) ? mapped[1] : entry;
}

/** `10.0.0.0/8`, `fd00::/8`, or a bare address. */
export function parseAllowedHost(entry: string): ParsedEntry {
  const trimmed = entry.trim();
  if (trimmed === "") return { ok: false, entry, reason: "empty" };

  const slash = trimmed.lastIndexOf("/");
  const addr = unmapIPv4(slash === -1 ? trimmed : trimmed.slice(0, slash));

  const family = isIPv4(addr) ? "ipv4" : isIPv6(addr) ? "ipv6" : undefined;
  if (family === undefined) return { ok: false, entry, reason: "not an IP address" };

  if (slash === -1) return { ok: true, ip: addr, family };

  // Digits only, deliberately. `Number("")` is 0 and `Number("0x8")` is 8, so
  // a bare `10.0.0.0/` would otherwise parse as `/0` — an entry that reads like
  // a typo and matches the entire address space.
  const width = family === "ipv4" ? 32 : 128;
  const digits = trimmed.slice(slash + 1);
  const prefix = /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
  if (!Number.isInteger(prefix) || prefix > width) {
    return { ok: false, entry, reason: `prefix must be an integer in 0..=${width}` };
  }
  return { ok: true, ip: addr, family, prefix };
}

/** Every entry that will be ignored, with why. Used to warn at startup. */
export function invalidAllowedHosts(entries: readonly string[]): { entry: string; reason: string }[] {
  return entries
    .map(parseAllowedHost)
    .filter((p): p is Extract<ParsedEntry, { ok: false }> => !p.ok)
    .map(({ entry, reason }) => ({ entry, reason }));
}

/**
 * The compiled allowlist, or `null` when `allowed_hosts` is empty and every
 * peer is allowed.
 *
 * Built once when the server config is applied rather than per connection —
 * `#accept` runs on every inbound socket and has no business parsing config.
 */
export function buildAllowlist(entries: readonly string[]): PeerAllowlist | null {
  if (entries.length === 0) return null;

  const block = new BlockList();
  for (const parsed of entries.map(parseAllowedHost)) {
    if (!parsed.ok) continue;
    if (parsed.prefix === undefined) block.addAddress(parsed.ip, parsed.family);
    else block.addSubnet(parsed.ip, parsed.prefix, parsed.family);
  }
  return new PeerAllowlist(block);
}

export class PeerAllowlist {
  readonly #block: BlockList;

  constructor(block: BlockList) {
    this.#block = block;
  }

  /**
   * Whether this peer may connect.
   *
   * The family comes from the address itself, because `socket.remoteAddress`
   * is whatever the listener's family produced and not what the config author
   * had in mind. A v6-shaped peer is checked as v6 even when it is really a
   * mapped v4 address — `BlockList` is what unwraps it against the v4 rules.
   */
  check(peer: string): boolean {
    if (isIPv4(peer)) return this.#block.check(peer, "ipv4");
    if (isIPv6(peer)) return this.#block.check(peer, "ipv6");
    return false;
  }
}
