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
    python3 daemon/scripts/mutate_daemon_startup.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = "src/daemon/startup.ts"

TESTS = ["tests/daemon_startup.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    (
        'precedence: SHORE_ADDR beats --addr',
        'src/daemon/startup.ts',
        '  if (cliAddr !== undefined) return [cliAddr, "cli"];\n  if (envAddr !== undefined && envAddr.trim() !== "") return [envAddr, "env"];',
        '  if (envAddr !== undefined && envAddr.trim() !== "") return [envAddr, "env"];\n  if (cliAddr !== undefined) return [cliAddr, "cli"];',
    ),
    (
        'precedence: a blank SHORE_ADDR is a value, so the config addr is ignored',
        'src/daemon/startup.ts',
        '  if (envAddr !== undefined && envAddr.trim() !== "") return [envAddr, "env"];',
        '  if (envAddr !== undefined) return [envAddr, "env"];',
    ),
    (
        'precedence: --addr is reported as coming from the config file',
        'src/daemon/startup.ts',
        '  if (cliAddr !== undefined) return [cliAddr, "cli"];',
        '  if (cliAddr !== undefined) return [cliAddr, "config"];',
    ),
    (
        'config path: a directory is accepted, re-homing every directory somewhere empty',
        'src/daemon/startup.ts',
        '  if (stat.isDirectory()) {',
        '  if (false) {',
    ),
    (
        'config path: a missing file is passed to the loader instead of refused',
        'src/daemon/startup.ts',
        '  } catch {\n    throw new StartupError(\n      "invalid_config_path",\n      `Invalid --config path ${path}: file does not exist`,\n    );\n  }',
        '  } catch {\n    return path;\n  }',
    ),
    (
        "config path: the resolved path is the flag rather than the loader's default",
        'src/daemon/startup.ts',
        '    configPath: explicitConfigPath ?? defaultConfigPath(env),',
        '    configPath: explicitConfigPath ?? "config.toml",',
    ),
    (
        'args: an unknown flag is skipped, so a misspelled --addr binds elsewhere',
        'src/daemon/startup.ts',
        '      default:\n        throw new Error(`unexpected argument ${JSON.stringify(arg)}`);',
        '      default:\n        break;',
    ),
    (
        'args: a flag with no value takes undefined rather than failing',
        'src/daemon/startup.ts',
        '      if (next === undefined) throw new Error(`${flag} requires a value`);',
        '      if (next === undefined) return "";',
    ),
    (
        'args: --addr and --config are swapped',
        'src/daemon/startup.ts',
        '      case "--config":\n        cli.config = value();\n        break;\n      case "--addr":\n        cli.addr = value();\n        break;',
        '      case "--config":\n        cli.addr = value();\n        break;\n      case "--addr":\n        cli.config = value();\n        break;',
    ),
    (
        'log: every source prints the same label, so a refusal cannot be acted on',
        'src/daemon/startup.ts',
        '    case "env":\n      return "SHORE_ADDR";',
        '    case "env":\n      return "[daemon].addr";',
    ),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
