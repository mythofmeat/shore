import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { defaultNotificationsConfig, defaultWebConfig } from "../src/config/app.ts";
import { tokenMatches } from "../src/config/token.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import { assemblePrompt } from "../src/engine/prompt.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { persistAndNotify, type PersistContext, type PersistEngine } from "../src/handler/persistence.ts";
import { buildLlmMessages } from "../src/handler/wire_messages.ts";
import type { StreamResult } from "../src/llm/stream.ts";
import { NotificationService, realSink, type NotificationPicture, type NotificationSink } from "../src/notifications.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { findSentPicture, sentPicturesDir } from "../src/storage/sent_pictures.ts";
import { Server } from "../src/swp/server.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { startWebServer } from "../src/web/server.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class Engine implements PersistEngine {
  messages: Message[] = [];
  #revision = 0;
  appendMessage(msg: Message): Promise<void> { this.messages.push(msg); this.#revision += 1; return Promise.resolve(); }
  replaceAfterLastUserTurn(messages: Message[]): Promise<number> { this.messages = messages; this.#revision += 1; return Promise.resolve(0); }
  currentRevision(): number { return this.#revision; }
  turnCount(): number { return this.messages.length; }
}

function result(blocks: ContentBlock[]): StreamResult {
  return {
    content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    model: "claude-test",
    finish_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
    tool_uses: [],
    content_blocks: blocks,
  };
}

function message(role: Message["role"], text: string, extra: Partial<Message> = {}): Message {
  return { msg_id: `m_${text.length}_${role}`, role, content: text, images: [], content_blocks: [{ type: "text", text }], timestamp: "2026-10-10T10:00:00Z", ...extra };
}

async function workspace(): Promise<{ root: string; dir: string; data: string }> {
  const root = await mkdtemp(testTmp("shore-picture-delivery-"));
  const dir = join(root, "workspace");
  await mkdir(join(dir, "art"), { recursive: true });
  await writeFile(join(dir, "art", "2026-01-01-lighthouse.png"), await sizedImage(64, 48));
  return { root, dir, data: join(root, "data") };
}

test("a reply's embeds are sent with it, shown to the user and named in the notification", async () => {
  const { dir, data } = await workspace();
  const events: ServerMessage[] = [];
  const notified: { body: string; picture: NotificationPicture | undefined }[] = [];
  const sink: NotificationSink = {
    notifySend: (_title, body, picture) => { notified.push({ body, picture }); return Promise.resolve(); },
    ntfy: () => Promise.resolve(),
    command: () => Promise.resolve(),
  };
  let ids = 0;
  const ctx: PersistContext = {
    emitEvent: (event) => events.push(event),
    sendDirect: () => {},
    autonomy: { notifyLastRequest: () => {}, notifyAssistantMessage: () => {} },
    notifier: new NotificationService({ ...defaultNotificationsConfig(), enabled: true, events: { ...defaultNotificationsConfig().events, message_complete: true } }, sink),
    newlyCrossedUsageBudgetWarnings: () => Promise.resolve([]),
    newlyCrossedPlanLimitWarnings: () => Promise.resolve([]),
    now: () => "2026-10-10T10:00:00Z",
    newMessageId: () => `m_${String(ids += 1)}`,
  };
  const engine = new Engine();
  const text = "I drew this while you slept\n\n![[2026-01-01-lighthouse]]\n\nand ![[nothing]]";

  await persistAndNotify(ctx, engine, {
    charName: "qifei",
    resolvedProviderKey: "anthropic",
    result: result([{ type: "text", text }]),
    request: { model: "claude-test", messages: [] },
    keepaliveIntervalMs: undefined,
    toolIntermediateMessages: [],
    wallClockMs: 1,
    pictures: { workspace: new CharacterWorkspace(dir), dir: sentPicturesDir(data, "qifei") },
  });

  const [stored] = engine.messages;
  expect(stored?.content_blocks).toEqual([{ type: "text", text }]);
  const [sent, unsent] = stored?.images ?? [];
  expect(sent?.name).toBe("2026-01-01-lighthouse.png");
  expect(unsent).toEqual({ path: "", embed: "![[nothing]]", problem: "no picture matches" });
  expect(findSentPicture(data, basename(sent?.path ?? ""))).toBe(sent?.path ?? "");
  const emitted = events[0] as Extract<ServerMessage, { type: "new_message" }>;
  expect(emitted.images[0]?.data).toBe((await readFile(join(dir, "art", "2026-01-01-lighthouse.png"))).toString("base64"));
  await Bun.sleep(10);
  expect(notified).toEqual([{
    body: "I drew this while you slept\n\n[picture: 2026-01-01-lighthouse.png]\n\nand [picture not sent: nothing]",
    picture: { path: sent?.path ?? "", name: "2026-01-01-lighthouse.png" },
  }]);
});

test("the model sees its embeds as it wrote them, without the pictures, and hears about unsent ones with the next turn", async () => {
  const assistant = message("assistant", "look ![[lighthouse]] and ![[gone]]", {
    images: [
      { path: "/data/media/qifei/sent/a.png", embed: "![[lighthouse]]", name: "lighthouse.png" },
      { path: "", embed: "![[gone]]", problem: "no picture matches" },
    ],
  });
  const prompt = assemblePrompt({
    character_name: "qifei", display_name: "ren", has_prior_context: false, user_timestamp_mode: "never",
    messages: [message("user", "hi"), assistant, message("user", "it's lovely")],
  });
  const { messages } = await buildLlmMessages(prompt, "tool_pair");
  expect(messages.map((wire) => [wire.role, wire.content])).toEqual([
    ["user", [{ type: "text", text: "hi" }]],
    ["assistant", [{ type: "text", text: "look ![[lighthouse]] and ![[gone]]" }]],
    ["user", [
      { type: "text", text: "[These pictures in your last message were not sent, so only their names were shown:\n- ![[gone]]: no picture matches\nSend a picture again in a new message if you meant to show it.]" },
      { type: "text", text: "it's lovely" },
    ]],
  ]);
});

test("ntfy gets the picture as an attachment, and the plain notification when it refuses one", async () => {
  const { dir } = await workspace();
  const picture = { path: join(dir, "art", "2026-01-01-lighthouse.png"), name: "灯塔.png" };
  const seen: { method: string; headers: Record<string, string>; bytes: number }[] = [];
  let refuse = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      seen.push({ method: request.method, headers: Object.fromEntries(request.headers), bytes: (await request.arrayBuffer()).byteLength });
      return new Response(null, { status: refuse && request.method === "PUT" ? 400 : 200 });
    },
  });
  cleanups.push(() => server.stop(true));
  const config = { url: `http://127.0.0.1:${String(server.port)}`, topic: "shore", token: "" };

  await realSink.ntfy(config, "Shore - qifei", "for you\n[picture: 灯塔.png]", picture);
  refuse = true;
  await realSink.ntfy(config, "Shore - qifei", "again", picture);

  const size = (await readFile(picture.path)).byteLength;
  expect(seen.map(({ method, bytes }) => [method, bytes])).toEqual([["PUT", size], ["PUT", size], ["POST", 5]]);
  expect(seen[0]?.headers["title"]).toBe("Shore - qifei");
  expect(seen[0]?.headers["message"]).toBe(`=?UTF-8?B?${Buffer.from("for you\n[picture: 灯塔.png]").toString("base64")}?=`);
  expect(seen[0]?.headers["filename"]).toBe(`=?UTF-8?B?${Buffer.from("灯塔.png").toString("base64")}?=`);
});

test("signed-in pages can load a sent picture without an Origin header, and nobody else can", async () => {
  const { data, dir } = await workspace();
  const bytes = await readFile(join(dir, "art", "2026-01-01-lighthouse.png"));
  const kept = join(sentPicturesDir(data, "qifei"), `${"a".repeat(64)}.png`);
  await mkdir(sentPicturesDir(data, "qifei"), { recursive: true });
  await writeFile(kept, bytes);
  const swp = new Server({
    addr: "127.0.0.1:0", serverName: "picture-test", authenticate: (token) => tokenMatches("token", token),
    handshake: { hello: async () => ({ characters: [] }), history: async () => ({ messages: [], previousSegment: null, config: {}, selectedCharacter: null, selectedThread: "main", revision: 0 }) },
  });
  await swp.bind();
  const served = swp.serve();
  const web = startWebServer({
    server: swp, authenticate: (token) => tokenMatches("token", token),
    config: { ...defaultWebConfig(), enabled: true, bind_addr: "127.0.0.1:0" },
    picture: (file) => findSentPicture(data, file),
  });
  web.activate();
  cleanups.push(async () => { await web.stop(); swp.stop(); await served; });
  const login = await fetch(`${web.origin}/api/login`, { method: "POST", headers: { origin: web.origin, "content-type": "application/json" }, body: JSON.stringify({ token: "token" }) });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const picture = (file: string, headers?: Record<string, string>) => fetch(`${web.origin}/api/pictures/${file}`, { headers: headers ?? { cookie } });

  const shown = await picture(basename(kept));
  expect(shown.status).toBe(200);
  expect(shown.headers.get("content-type")).toBe("image/png");
  expect(shown.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(Buffer.from(await shown.arrayBuffer())).toEqual(bytes);
  expect((await picture(basename(kept), { cookie, "sec-fetch-site": "same-origin" })).status).toBe(200);
  expect((await picture(basename(kept), {})).status).toBe(401);
  expect((await picture(basename(kept), { cookie, "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await picture(`${"b".repeat(64)}.png`)).status).toBe(404);
  expect((await picture("..%2F..%2Fshore.db")).status).toBe(404);
});

test("a message keeps what its pictures were, but not their data, when it is stored and loaded again", async () => {
  const { root } = await workspace();
  const path = join(root, "messages.json");
  const store = MessageStore.create(path);
  const sent = { path: "/data/media/qifei/sent/a.png", embed: "![[lighthouse|at dusk]]", name: "lighthouse.png", caption: "at dusk" };
  const unsent = { path: "", embed: "![[gone]]", problem: "no picture matches" };
  await store.append(message("user", "hi"));
  await store.append(message("assistant", "![[lighthouse|at dusk]] ![[gone]]", { images: [{ ...sent, data: "iVBORw0KGgo=" }, unsent] }));
  const loaded = await MessageStore.load(path);
  expect(loaded.messages().at(-1)?.images).toEqual([sent, unsent]);
});
