import { createClient, type ICreateClientOpts, type MatrixClient } from "matrix-js-sdk";

type RequestOtherUrl = MatrixClient["http"]["requestOtherUrl"];

export function createStoppableClient(
  stopSignal: AbortSignal,
  options: ICreateClientOpts,
): MatrixClient {
  const client = createClient({ ...options, fetchFn: fetchUntil(stopSignal) });
  const request = client.http.requestOtherUrl.bind(client.http);
  client.http.requestOtherUrl = <T>(...args: Parameters<RequestOtherUrl>): Promise<T> =>
    answeredUntil(stopSignal, () => requestWithOwnTimeout<T>(request, args));
  return client;
}

function fetchUntil(stopSignal: AbortSignal): typeof fetch {
  return ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> =>
    fetch(input, { ...init, signal: eitherSignal(init?.signal, stopSignal) })) as typeof fetch;
}

async function answeredUntil<T>(stopSignal: AbortSignal, ask: () => Promise<T>): Promise<T> {
  if (stopSignal.aborted) return await neverSettles();
  try {
    return await ask();
  } finally {
    if (stopSignal.aborted) await neverSettles();
  }
}

async function requestWithOwnTimeout<T>(
  request: RequestOtherUrl,
  [method, url, body, options]: Parameters<RequestOtherUrl>,
): Promise<T> {
  if (options?.localTimeoutMs === undefined) return await request<T>(method, url, body, options);

  const { localTimeoutMs, ...untimed } = options;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), localTimeoutMs);
  try {
    return await request<T>(method, url, body, {
      ...untimed,
      abortSignal: eitherSignal(untimed.abortSignal, timeout.signal),
    });
  } finally {
    clearTimeout(timer);
  }
}

function eitherSignal(first: AbortSignal | null | undefined, second: AbortSignal): AbortSignal {
  return first === undefined || first === null ? second : AbortSignal.any([first, second]);
}

function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}
