import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { bookPathIn, sessionKey } from "../src/llm/providers/agent_sessions.ts";
import { nativeHistoryStore } from "../src/llm/providers/claude_agent_history.ts";
import { useImageCacheFor } from "../src/storage/image_blobs.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { writeState } from "../src/storage/store.ts";
import { characterTexts, Texts, useCharacterTexts } from "../src/texts/texts.ts";
import { testTmp } from "./support/tmp.ts";

const GIF = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

function world() {
  const data = mkdtempSync(testTmp("native-history-"));
  const cache = mkdtempSync(testTmp("native-cache-"));
  initializeDatabase(data);
  useImageCacheFor(data, cache);
  const book = bookPathIn(data);
  const store = nativeHistoryStore(book, sessionKey("ada", "", "main"));
  const path = (sessionId: string) => `sdk_transcripts/${book.split("/").at(-1) ?? ""}/${Buffer.from("ada").toString("base64url")}/${Buffer.from(sessionId).toString("base64url")}/`;
  return { data, cache, store, path };
}

afterEach(() => { useCharacterTexts(() => new Texts()); });

test("a transcript never written is missing, and one written is read back in order, an entry written again under its uuid replacing the first", async () => {
  const { store } = world();
  const key = { projectKey: "p", sessionId: "s1" };
  expect(await store.load(key)).toBeNull();
  const appended = store.append(key, [{ type: "user", uuid: "u1", n: 1 }, { type: "note", n: 2 }]);
  expect(appended).toBeInstanceOf(Promise);
  await appended;
  await store.append(key, [{ type: "user", uuid: "u1", n: 3 }, { type: "note", n: 2 }]);
  expect(await store.load(key)).toEqual([{ type: "user", uuid: "u1", n: 3 }, { type: "note", n: 2 }, { type: "note", n: 2 }]);
  expect(await store.load({ ...key, subpath: "subagents/a" })).toBeNull();
});

test("a transcript an older version kept as one file is read as it was", async () => {
  const { data, store, path } = world();
  writeState(data, path("old"), JSON.stringify([{ type: "user", uuid: "u1" }]), "ada");
  expect(await store.load({ projectKey: "p", sessionId: "old" })).toEqual([{ type: "user", uuid: "u1" }]);
});

test("a picture in a transcript is kept in the image cache, marked used each time the transcript is read, and told in the character's wording of picture_gone once it is gone", async () => {
  const { cache, store } = world();
  const key = { projectKey: "p", sessionId: "s2" };
  await store.append(key, [{ type: "user", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/gif", data: GIF } }] } }]);
  const blobs = join(cache, "characters", "ada", "images", "blobs");
  const kept = readdirSync(blobs).map((name) => join(blobs, name));
  expect(kept).toHaveLength(1);
  const old = new Date("2001-01-01T00:00:00Z");
  utimesSync(kept[0] ?? "", old, old);
  expect(await store.load(key)).toEqual([{ type: "user", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/gif", data: GIF } }] } }]);
  expect(statSync(kept[0] ?? "").mtimeMs).toBeGreaterThan(old.getTime());
  useCharacterTexts((character) => Texts.from({ picture_gone: character === "ada" ? "(ada lost {{name}})" : "(lost)" }));
  expect(characterTexts("ada").render("picture_gone", { name: "x" })).toBe("(ada lost x)");
  await Promise.all(kept.map((file) => Bun.file(file).delete().catch(() => undefined)));
  const loaded = await store.load(key) as unknown as { message: { content: { type: string; text?: string }[] } }[];
  expect(loaded[0]?.message.content.map((block) => block.type)).toEqual(["text"]);
  expect(loaded[0]?.message.content[0]?.text).toMatch(/^\(ada lost [0-9a-f]{12}\.gif\)$/);
});
