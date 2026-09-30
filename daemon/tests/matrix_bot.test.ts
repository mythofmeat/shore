import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MatrixBot, type BotConfig } from "../src/connections/matrix/bot.ts";
import {
  fakeHomeserver,
  type FakeHomeserver,
  type HomeserverRequest,
} from "./support/matrix_homeserver.ts";
import { testTmp } from "./support/tmp.ts";
import { until } from "./support/until.ts";

const ROOM = "!room:example.com";

const homeservers: FakeHomeserver[] = [];
const bots: MatrixBot[] = [];

afterEach(async () => {
  for (const bot of bots.splice(0)) bot.stop();
  for (const homeserver of homeservers.splice(0)) await homeserver.close();
});

async function silentHomeserver(): Promise<FakeHomeserver> {
  const homeserver = await fakeHomeserver(() => "never");
  homeservers.push(homeserver);
  return homeserver;
}

async function loginAt(homeserver: FakeHomeserver, config: Partial<BotConfig> = {}): Promise<MatrixBot> {
  const bot = await MatrixBot.login({
    homeserver: homeserver.url,
    userId: "@shore:example.com",
    accessToken: "bot-test-token",
    ...config,
  });
  bots.push(bot);
  return bot;
}

async function botAtASilentHomeserver(): Promise<{ bot: MatrixBot; homeserver: FakeHomeserver }> {
  const homeserver = await silentHomeserver();
  return { bot: await loginAt(homeserver), homeserver };
}

async function asked(homeserver: FakeHomeserver, path: string): Promise<HomeserverRequest> {
  const matches = (request: HomeserverRequest) => request.path.includes(path);
  await until(() => homeserver.requests.some(matches), `a request for ${path}`);
  const request = homeserver.requests.find(matches);
  if (request === undefined) throw new Error(`the homeserver recorded no request for ${path}`);
  return request;
}

function failureOf(attempt: Promise<unknown>): Promise<unknown> {
  return attempt.then(
    () => undefined,
    (failure: unknown) => failure,
  );
}

function picture(): string {
  const path = join(mkdtempSync(testTmp("shore-matrix-bot-")), "picture.png");
  writeFileSync(path, new Uint8Array([137, 80, 78, 71]));
  return path;
}

const unanswered: readonly (readonly [string, (bot: MatrixBot) => Promise<unknown>, unknown])[] = [
  ["a text message", (bot) => bot.sendText(ROOM, "are you there?"), undefined],
  ["a notice", (bot) => bot.sendNotice(ROOM, "are you there?"), undefined],
  ["an edit", (bot) => bot.editText(ROOM, "$sent", "are you there?"), false],
  ["a redaction", (bot) => bot.redact(ROOM, "$sent"), undefined],
  ["a typing notice", (bot) => bot.setTyping(ROOM, true), undefined],
  ["an image upload", (bot) => bot.sendImage(ROOM, picture()), undefined],
  [
    "a profile change",
    (bot) => bot.setProfile("Ada", { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" }),
    undefined,
  ],
  ["a room alias lookup", (bot) => bot.resolveRoom("#room:example.com"), undefined],
  [
    "a media download",
    (bot) => bot.downloadMedia("mxc://example.com/picture"),
    { ok: false, reason: "failed" },
  ],
];

describe("stopping a Matrix bot", () => {
  test.each(unanswered)(
    "ends %s still in flight as failed instead of leaving it waiting on the homeserver",
    async (_what, ask, failure) => {
      const { bot, homeserver } = await botAtASilentHomeserver();
      const asking = ask(bot);
      await until(() => homeserver.requests.length > 0, "the request reaching the homeserver");

      bot.stop();

      expect(await asking).toEqual(failure);
      await until(() => homeserver.requests.every((request) => request.hungUp), "the bot hanging up");
    },
  );

  test("fails a start still waiting for the homeserver", async () => {
    const { bot, homeserver } = await botAtASilentHomeserver();
    const starting = bot.start();
    const request = await asked(homeserver, "/versions");

    bot.stop();

    expect(await failureOf(starting)).toMatchObject({ name: "AbortError" });
    await until(() => request.hungUp, "the bot hanging up");
  });

  test("sends nothing afterwards", async () => {
    const { bot, homeserver } = await botAtASilentHomeserver();
    bot.stop();

    expect(await bot.sendText(ROOM, "too late")).toBeUndefined();
    expect(await bot.resolveRoom("#room:example.com")).toBeUndefined();
    expect(homeserver.requests).toEqual([]);
  });
});

describe("a Matrix bot given a signal", () => {
  test("stops when the signal aborts, ending its event stream", async () => {
    const stop = new AbortController();
    const bot = await loginAt(await silentHomeserver(), { signal: stop.signal });
    const next = bot.events().next();

    stop.abort();

    expect((await next).done).toBe(true);
  });

  test("gives up a password login still in flight when the signal aborts", async () => {
    const stop = new AbortController();
    const homeserver = await silentHomeserver();
    const login = loginAt(homeserver, {
      accessToken: undefined,
      password: "bot-test-password",
      signal: stop.signal,
    });
    const request = await asked(homeserver, "/login");

    stop.abort();

    expect(await failureOf(login)).toMatchObject({ name: "AbortError" });
    await until(() => request.hungUp, "the login being dropped");
  });

  test("is not logged in once the signal has already aborted", async () => {
    const login = loginAt(await silentHomeserver(), { signal: AbortSignal.abort() });
    expect(await failureOf(login)).toMatchObject({ name: "AbortError" });
  });
});
