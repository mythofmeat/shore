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
  constructor(seconds: number) {
    super(`timed out after ${seconds}s and was cancelled`);
    this.name = "ToolTimedOut";
  }
}
