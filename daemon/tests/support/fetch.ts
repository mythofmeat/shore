export function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

export function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new TypeError(
      `this stub only ever receives a string body, got ${body === null ? "null" : typeof body}`,
    );
  }
  return body;
}
