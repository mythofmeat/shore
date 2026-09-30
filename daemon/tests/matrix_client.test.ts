import { afterEach, describe, expect, test } from "bun:test";
import { Method, type ICreateClientOpts, type IRequestOpts, type MatrixClient } from "matrix-js-sdk";

import { createStoppableClient } from "../src/connections/matrix/client.ts";
import {
  fakeHomeserver,
  healthyAnswer,
  type FakeHomeserver,
  type HomeserverRequest,
} from "./support/matrix_homeserver.ts";
import { until } from "./support/until.ts";

const UNANSWERED = "/unanswered";

function recordingIn(logged: string[]): NonNullable<ICreateClientOpts["logger"]> {
  const record = (...message: unknown[]): void => {
    logged.push(message.map(String).join(" "));
  };
  const logger = {
    trace: record,
    debug: record,
    info: record,
    warn: record,
    error: record,
    getChild: () => logger,
  };
  return logger;
}

const homeservers: FakeHomeserver[] = [];

afterEach(async () => {
  for (const homeserver of homeservers.splice(0)) await homeserver.close();
});

async function stoppableClient(): Promise<{
  client: MatrixClient;
  homeserver: FakeHomeserver;
  stop: AbortController;
  logged: string[];
}> {
  const homeserver = await fakeHomeserver((request) =>
    request.path.endsWith(UNANSWERED) ? "never" : healthyAnswer(request),
  );
  homeservers.push(homeserver);
  const stop = new AbortController();
  const logged: string[] = [];
  const client = createStoppableClient(stop.signal, {
    baseUrl: homeserver.url,
    accessToken: "client-test-token",
    logger: recordingIn(logged),
  });
  return { client, homeserver, stop, logged };
}

function ask(
  client: MatrixClient,
  path: string,
  patience: Partial<IRequestOpts> = {},
): Promise<unknown> {
  return client.http.authedRequest(Method.Get, path, undefined, undefined, patience as IRequestOpts);
}

async function unansweredRequest(homeserver: FakeHomeserver): Promise<HomeserverRequest> {
  await until(() => homeserver.requests.length > 0, "the request reaching the homeserver");
  const [request] = homeserver.requests;
  if (request === undefined) throw new Error("the homeserver recorded no request");
  return request;
}

function failureOf(answer: Promise<unknown>): Promise<unknown> {
  return answer.then(
    () => undefined,
    (failure: unknown) => failure,
  );
}

async function heardWithin(answer: Promise<unknown>, ms: number): Promise<string> {
  return await Promise.race([
    answer.then(
      () => "answered",
      () => "failed",
    ),
    Bun.sleep(ms).then(() => "nothing"),
  ]);
}

describe("a Matrix client that can be stopped", () => {
  test("still delivers what the homeserver answers", async () => {
    const { client } = await stoppableClient();
    expect(await ask(client, "/capabilities")).toEqual({ capabilities: {} });
  });

  test("gives up on a request once its local timeout passes", async () => {
    const { client } = await stoppableClient();
    const answer = ask(client, UNANSWERED, { localTimeoutMs: 20 });

    expect(await failureOf(answer)).toMatchObject({ name: "AbortError" });
  });

  test("gives up on a request its caller aborts, whatever its local timeout", async () => {
    const { client, homeserver } = await stoppableClient();
    const caller = new AbortController();
    const answer = ask(client, UNANSWERED, { localTimeoutMs: 600_000, abortSignal: caller.signal });
    const request = await unansweredRequest(homeserver);

    caller.abort();
    expect(await failureOf(answer)).toMatchObject({ name: "AbortError" });
    await until(() => request.hungUp, "the client hanging up");
  });

  test("hangs up on a request in flight when it stops, and never reports how it ended", async () => {
    const { client, homeserver, stop } = await stoppableClient();
    const answer = ask(client, UNANSWERED);
    const request = await unansweredRequest(homeserver);

    stop.abort();
    await until(() => request.hungUp, "the client hanging up");
    expect(await heardWithin(answer, 50)).toBe("nothing");
  });

  test("asks the homeserver nothing once it has stopped, and logs no request", async () => {
    const { client, homeserver, stop, logged } = await stoppableClient();
    stop.abort();

    expect(await heardWithin(ask(client, "/capabilities"), 50)).toBe("nothing");
    expect(homeserver.requests).toEqual([]);
    expect(logged).toEqual([]);
  });
});
