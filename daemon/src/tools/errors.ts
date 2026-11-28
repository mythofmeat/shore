import type { Texts } from "../texts/texts.ts";

export class InvalidArgs extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`invalid args: ${reason}`);
    this.name = "InvalidArgs";
    this.reason = reason;
  }
}

export class ToolIoError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`io: ${reason}`);
    this.name = "ToolIoError";
    this.reason = reason;
  }
}

export class NotImplemented extends Error {
  readonly tool: string;

  constructor(tool: string) {
    super(`${tool}: not yet implemented`);
    this.name = "NotImplemented";
    this.tool = tool;
  }
}

export interface StoppedOutput {
  stdout: string;
  stderr: string;
}

export class ToolTimedOut extends Error {
  readonly seconds: number;
  readonly stopped: boolean;
  readonly output: StoppedOutput | undefined;

  constructor(seconds: number, stopped: boolean, output?: StoppedOutput) {
    super(`timed out after ${String(seconds)}s`);
    this.name = "ToolTimedOut";
    this.seconds = seconds;
    this.stopped = stopped;
    this.output = output;
  }
}

function printed(texts: Texts, output: StoppedOutput): string {
  const stderr = output.stderr === "" ? undefined : texts.render("tool_stderr", { stderr: output.stderr.replace(/\n$/, "") });
  return [output.stdout.replace(/\n$/, ""), stderr].filter((part) => part !== undefined && part !== "").join("\n");
}

export function errorText(texts: Texts, error: unknown): string {
  if (error instanceof InvalidArgs) return texts.always("tool_invalid_args", { error: error.reason });
  if (error instanceof ToolIoError) return texts.always("tool_io", { error: error.reason });
  if (error instanceof NotImplemented) return texts.always("tool_not_implemented", { tool: error.tool });
  if (error instanceof ToolTimedOut) {
    const seconds = String(error.seconds);
    if (!error.stopped) return texts.always("tool_timed_out_unconfirmed", { seconds });
    return texts.always("tool_timed_out", { seconds, stopped: error.output === undefined ? undefined : "yes", output: error.output === undefined ? undefined : printed(texts, error.output) });
  }
  return error instanceof Error ? error.message : String(error);
}
