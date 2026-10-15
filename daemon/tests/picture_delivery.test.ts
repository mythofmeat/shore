import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { defaultWebConfig } from "../src/config/app.ts";
import { tokenMatches } from "../src/config/token.ts";
import { findSentPicture, sentPicturesDir } from "../src/storage/sent_pictures.ts";
import { Server } from "../src/swp/server.ts";
import { startWebServer } from "../src/web/server.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function workspace(): Promise<{ root: string; dir: string; data: string }> {
  const root = await mkdtemp(testTmp("shore-picture-delivery-"));
  const dir = join(root, "workspace");
  await mkdir(join(dir, "art"), { recursive: true });
  await writeFile(join(dir, "art", "2026-01-01-lighthouse.png"), await sizedImage(64, 48));
  return { root, dir, data: join(root, "data") };
}

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
