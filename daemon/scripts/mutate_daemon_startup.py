#!/usr/bin/env python3
"""Mutation pass over the daemon's startup policy: where the listen address
comes from, the config path check, and argument parsing.
"""
import sys


TESTS = ["tests/daemon_startup.test.ts"]

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
