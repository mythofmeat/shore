import { dirname, isAbsolute, join } from "node:path";

const CLAUDE_CODE_PATH_ENV = "SHORE_CLAUDE_PATH";

export const BUNDLED_CLAUDE_CODE = process.platform === "win32" ? "shore-claude.exe" : "shore-claude";

const LAUNCH_FAILURES: ReadonlySet<string> = new Set(["executable_not_found", "executable_launch_failed"]);

export class ClaudeCodeLaunchFailed extends Error {
  readonly kind = "launch_failed" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeCodeLaunchFailed";
  }
}

export function isCompiledDaemon(modulePath: string = import.meta.path): boolean {
  return modulePath.startsWith("/$bunfs/") || /^[A-Za-z]:\\~BUN\\/.test(modulePath);
}

export function claudeCodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  compiled: boolean = isCompiledDaemon(),
): string | undefined {
  const override = env[CLAUDE_CODE_PATH_ENV];
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new ClaudeCodeLaunchFailed(
        `${CLAUDE_CODE_PATH_ENV} must be an absolute path to a Claude Code executable, not ${JSON.stringify(override)}`,
      );
    }
    return override;
  }
  return compiled ? join(dirname(execPath), BUNDLED_CLAUDE_CODE) : undefined;
}

export function claudeCodeOptions(): { pathToClaudeCodeExecutable?: string } {
  const path = claudeCodeExecutable();
  return path === undefined ? {} : { pathToClaudeCodeExecutable: path };
}

export function claudeCodeLaunchFailure(
  error: unknown,
  compiled: boolean = isCompiledDaemon(),
): ClaudeCodeLaunchFailed | undefined {
  if (error instanceof ClaudeCodeLaunchFailed) return error;
  if (!(error instanceof Error)) return undefined;
  const errorClass = (error as { errorClass?: unknown }).errorClass;
  const launch = typeof errorClass === "string" && LAUNCH_FAILURES.has(errorClass);
  if (!launch && !error.message.startsWith("Native CLI binary for ")) return undefined;
  const detail = error.message.replaceAll("options.pathToClaudeCodeExecutable", CLAUDE_CODE_PATH_ENV);
  const bundled = compiled ? ` shore-daemon runs the ${BUNDLED_CLAUDE_CODE} beside it, which bun run build puts in dist/.` : "";
  return new ClaudeCodeLaunchFailed(`Claude Code could not start: ${detail}${bundled}`, { cause: error });
}
