#!/usr/bin/env python3
"""Mutation pass over the daemon's startup policy (#18, step 5).

Every other harness in this repo asks whether a wrong answer would be noticed.
This one asks something narrower, because the code decides how exposed the
daemon is: **would the mutant open a port nobody asked to open?**

Three families:

**Loopback.** `Ipv4Addr::is_loopback` is the whole `127/8` block and
`Ipv6Addr::is_loopback` is `::1` alone. Widening either — reading an
IPv4-mapped `::ffff:127.0.0.1` as loopback, say — skips the opt-in check
entirely for an address that is reachable off-host on some stacks. Narrowing it
is only an annoyance, and is mutated anyway because the two mistakes are one
edit apart.

**Precedence.** `--addr` over `SHORE_ADDR` over `[daemon].addr`, and the
opt-in the other way round: the environment wins over config *in both
directions*, so `SHORE_UNSAFE_ALLOW_REMOTE_ACCESS=0` revokes a config opt-in. A
mutant that lets config win means an operator who locked a container down did
not.

**Refusal.** The two arms of `validate_remote_access_policy` that say no — an
unparseable address, and a non-loopback bind with no opt-in. Both are silent
when wrong: the daemon starts, and the only sign is a port answering.

A mutant is KILLED if `bun test tests/daemon_startup.test.ts` fails with it
applied.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_daemon_startup.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = "src/daemon/startup.ts"

TESTS = ["tests/daemon_startup.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- loopback -------------------------------------------------------------
    ("loopback: only 127.0.0.1 counts, so a 127/8 bind is refused",
     S,
     '  if ("v4" in ip) return ip.v4[0] === 127;',
     '  if ("v4" in ip) return ip.v4.join(".") === "127.0.0.1";'),
    ("loopback: any IPv6 counts, so [::]:7320 binds the world with no opt-in",
     S,
     "  return ip.v6.every((group, i) => group === (i === 7 ? 1 : 0));",
     "  return true;"),
    ("loopback: the ::1 check ignores the leading groups, so ::ffff:0:1 passes",
     S,
     "  return ip.v6.every((group, i) => group === (i === 7 ? 1 : 0));",
     "  return ip.v6[7] === 1;"),
    ("loopback: the IP literal path is skipped, so 127.0.0.2 is treated as remote",
     S,
     "  const ip = parseSocketAddrIp(addr);\n  if (ip !== undefined) return ipIsLoopback(ip);",
     "  const ip = parseSocketAddrIp(addr);\n  if (ip !== undefined && false) return ipIsLoopback(ip);"),
    ("loopback: the host fallback is dropped, so localhost:7320 is refused",
     S,
     '  return host === "localhost" || host === "127.0.0.1" || host === "::1";',
     "  return false;"),
    ("loopback: an unparseable address answers false rather than undefined",
     S,
     "  const host = extractBindHost(addr);\n  if (host === undefined) return undefined;",
     "  const host = extractBindHost(addr);\n  if (host === undefined) return false;"),
    ("loopback: a port over 65535 still parses, so 1.2.3.4:99999 is an IP",
     S,
     "  return Number(text) <= 65535;",
     "  return true;"),
    ("loopback: :: may stand for zero groups, so 1:2:3:4:5:6:7::8 parses",
     S,
     "  if (fill < 1) return undefined;",
     "  if (fill < 0) return undefined;"),

    # --- precedence -----------------------------------------------------------
    ("precedence: SHORE_ADDR beats --addr",
     S,
     '  if (cliAddr !== undefined) return [cliAddr, "cli"];\n'
     '  if (envAddr !== undefined && envAddr.trim() !== "") return [envAddr, "env"];',
     '  if (envAddr !== undefined && envAddr.trim() !== "") return [envAddr, "env"];\n'
     '  if (cliAddr !== undefined) return [cliAddr, "cli"];'),
    ("precedence: a blank SHORE_ADDR is a value, so the config addr is ignored",
     S,
     '  if (envAddr !== undefined && envAddr.trim() !== "") return [envAddr, "env"];',
     "  if (envAddr !== undefined) return [envAddr, \"env\"];"),
    ("precedence: config wins the opt-in, so an env opt-out does not revoke it",
     S,
     "  if (envAllowRemoteAccess !== undefined) return [envAllowRemoteAccess, ALLOW_REMOTE_ENV];",
     "  if (envAllowRemoteAccess === true) return [envAllowRemoteAccess, ALLOW_REMOTE_ENV];"),
    ("precedence: --addr is reported as coming from the config file",
     S,
     '  if (cliAddr !== undefined) return [cliAddr, "cli"];',
     '  if (cliAddr !== undefined) return [cliAddr, "config"];'),

    # --- refusal --------------------------------------------------------------
    ("refusal: a non-loopback bind is allowed without the opt-in",
     S,
     "  if (!unsafeAllowRemoteAccess) {",
     "  if (false) {"),
    ("refusal: an unparseable address is treated as loopback",
     S,
     "  if (loopback === undefined) {\n"
     "    return `Invalid daemon listen address ${JSON.stringify(addr)}. Expected HOST:PORT or [IPv6]:PORT.`;\n"
     "  }\n"
     "  if (loopback) return [];",
     "  if (loopback !== false) return [];"),
    ("refusal: the empty-allowlist warning is dropped",
     S,
     "  if (allowedHosts.length === 0) {",
     "  if (false) {"),
    ("refusal: an allowlist suppresses the security warning too",
     S,
     "  const warnings = [\n"
     '    "Remote TCP access is enabled. Shore does not provide authentication or TLS. Restrict Shore to trusted private or overlay networks; [daemon].allowed_hosts only narrows peer IPs and is not a complete security boundary.",\n'
     "  ];",
     "  const warnings = allowedHosts.length === 0\n"
     "    ? [\n"
     '        "Remote TCP access is enabled. Shore does not provide authentication or TLS. Restrict Shore to trusted private or overlay networks; [daemon].allowed_hosts only narrows peer IPs and is not a complete security boundary.",\n'
     "      ]\n"
     "    : [];"),
    ("refusal: the policy is never run, so resolveStartup accepts any address",
     S,
     "  if (typeof warnings === \"string\") {",
     "  if (false as boolean) {"),

    # --- the environment opt-in ----------------------------------------------
    ("env bool: garbage is ignored rather than fatal",
     S,
     "      throw new StartupError(\n"
     '        "invalid_env_bool",',
     "      return undefined;\n"
     "      throw new StartupError(\n"
     '        "invalid_env_bool",'),
    ("env bool: an unset variable reads as false, overriding a config opt-in",
     S,
     "  const raw = env[ALLOW_REMOTE_ENV];\n  if (raw === undefined) return undefined;",
     "  const raw = env[ALLOW_REMOTE_ENV];\n  if (raw === undefined) return false;"),
    ("env bool: a blank variable reads as true",
     S,
     '    case "":\n      return undefined;',
     '    case "":\n      return true;'),
    ("env bool: 'off' is not recognised, so it becomes an error instead of false",
     S,
     '    case "no":\n    case "off":\n      return false;',
     '    case "no":\n      return false;'),

    # --- --config -------------------------------------------------------------
    ("config path: a directory is accepted, re-homing every directory somewhere empty",
     S,
     "  if (stat.isDirectory()) {",
     "  if (false) {"),
    ("config path: a missing file is passed to the loader instead of refused",
     S,
     "  } catch {\n"
     "    throw new StartupError(\n"
     '      "invalid_config_path",\n'
     "      `Invalid --config path ${path}: file does not exist`,\n"
     "    );\n"
     "  }",
     "  } catch {\n    return path;\n  }"),
    ("config path: the resolved path is the flag rather than the loader's default",
     S,
     "    configPath: explicitConfigPath ?? defaultConfigPath(env),",
     "    configPath: explicitConfigPath ?? \"config.toml\","),

    # --- arguments ------------------------------------------------------------
    ("args: an unknown flag is skipped, so a misspelled --addr binds elsewhere",
     S,
     "      default:\n        throw new Error(`unexpected argument ${JSON.stringify(arg)}`);",
     "      default:\n        break;"),
    ("args: a flag with no value takes undefined rather than failing",
     S,
     "      if (next === undefined) throw new Error(`${flag} requires a value`);",
     "      if (next === undefined) return \"\";"),
    ("args: --addr and --config are swapped",
     S,
     '      case "--config":\n        cli.config = value();\n        break;\n'
     '      case "--addr":\n        cli.addr = value();\n        break;',
     '      case "--config":\n        cli.addr = value();\n        break;\n'
     '      case "--addr":\n        cli.config = value();\n        break;'),

    # --- the startup log ------------------------------------------------------
    ("log: every source prints the same label, so a refusal cannot be acted on",
     S,
     '    case "env":\n      return "SHORE_ADDR";',
     '    case "env":\n      return "[daemon].addr";'),
]


def run_tests() -> bool:
    """True when the suite passes."""
    proc = subprocess.run(
        ["bun", "test", *TESTS],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc.returncode == 0


def main() -> int:
    if not run_tests():
        print("baseline is red — fix the suite before mutating", file=sys.stderr)
        return 2

    survivors = []
    for i, (label, rel, find, replace) in enumerate(MUTANTS, start=1):
        path = ROOT / rel
        original = path.read_text()
        if find not in original:
            print(f"{i:3}. ERROR mutant does not apply: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        if original.count(find) != 1:
            print(f"{i:3}. ERROR mutant is ambiguous: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        path.write_text(original.replace(find, replace))
        try:
            killed = not run_tests()
        finally:
            path.write_text(original)
        print(f"{i:3}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append(label)

    print(f"\n{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} killed")
    for label in survivors:
        print(f"  SURVIVOR: {label}")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
