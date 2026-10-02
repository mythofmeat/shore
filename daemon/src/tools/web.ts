export class ToolHttpError extends Error {
  constructor(message: string) {
    super(`http: ${message}`);
    this.name = "ToolHttpError";
  }
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
