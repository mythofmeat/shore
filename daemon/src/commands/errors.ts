import { describeError } from "../llm/errors.ts";
import type { ErrorCode } from "../protocol/ErrorCode.ts";
import { InvalidAlt, MessageNotFound } from "../engine/message_store.ts";

export class CommandError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export const invalidRequest = (message: string): CommandError =>
  new CommandError("invalid_request", message);

export const notFound = (message: string): CommandError => new CommandError("not_found", message);

export const internalError = (message: string): CommandError =>
  new CommandError("internal_error", message);

export const providerError = (message: string): CommandError =>
  new CommandError("provider_error", message);

export function engineError(e: unknown): CommandError {
  if (e instanceof MessageNotFound) return notFound(e.message);
  if (e instanceof InvalidAlt) return invalidRequest(e.message);
  return internalError(describeError(e));
}
