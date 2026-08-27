export class InvalidArgs extends Error {
  constructor(message: string) {
    super(`invalid args: ${message}`);
    this.name = "InvalidArgs";
  }
}

export class ToolIoError extends Error {
  constructor(message: string) {
    super(`io: ${message}`);
    this.name = "ToolIoError";
  }
}

export class NotImplemented extends Error {
  constructor(name: string) {
    super(`${name}: not yet implemented`);
    this.name = "NotImplemented";
  }
}

export class ToolTimedOut extends Error {
  readonly stopped: boolean;

  constructor(seconds: number, stopped: boolean) {
    super(
      stopped
        ? `timed out after ${seconds}s and was cancelled`
        : `timed out after ${seconds}s. Shore asked it to stop and it has not confirmed ` +
          `that it did, so it may still be running and may still take effect. Do not ` +
          `repeat this call until you have checked whether the first one already ran.`,
    );
    this.name = "ToolTimedOut";
    this.stopped = stopped;
  }
}
