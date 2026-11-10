import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { pushToUser, type PushSettings } from "../src/autonomy/push.ts";
import { loadConfig } from "../src/config/loader.ts";
import { configSchema } from "../src/config/schema.ts";
import type { NtfyDelivery } from "../src/notifications.ts";
import { writeCharacterState } from "../src/storage/store.ts";
import { rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 30, 12);
const PHONE: PushSettings = { url: "https://ntfy.example", topic: "phone", token: "secret", everyMs: DAY };

interface Sent {
  delivery: NtfyDelivery;
  title: string;
  body: string;
}

async function character(): Promise<string> {
  return join(await mkdtemp(testTmp("shore-push-")), "ada");
}

function sender(sent: Sent[]): (delivery: NtfyDelivery, title: string, body: string) => Promise<void> {
  return async (delivery, title, body) => { sent.push({ delivery, title, body }); };
}

test("a push goes to the user's topic with the character's title, and the next is refused until the wait is over", async () => {
  const dir = await character();
  const sent: Sent[] = [];
  expect(await pushToUser(dir, "Shore - ada", "I miss you.", PHONE, T0, sender(sent))).toEqual({ kind: "sent", nextAt: T0 + DAY });
  expect(sent).toEqual([{ delivery: { url: "https://ntfy.example", topic: "phone", token: "secret" }, title: "Shore - ada", body: "I miss you." }]);

  expect(await pushToUser(dir, "Shore - ada", "Still here.", PHONE, T0 + DAY - 1, sender(sent))).toEqual({ kind: "too_soon", lastAt: T0, nextAt: T0 + DAY });
  expect(sent).toHaveLength(1);
  expect(await pushToUser(dir, "Shore - ada", "Still here.", PHONE, T0 + DAY, sender(sent))).toEqual({ kind: "sent", nextAt: T0 + 2 * DAY });
  expect(sent.map((each) => each.body)).toEqual(["I miss you.", "Still here."]);
  expect(await pushToUser(dir, "Shore - ada", "Again.", { ...PHONE, everyMs: HOUR }, T0 + DAY + HOUR - 1, sender(sent))).toEqual({ kind: "too_soon", lastAt: T0 + DAY, nextAt: T0 + DAY + HOUR });
});

test("with no topic set nothing is sent, and a push that fails doesn't use up the wait", async () => {
  const dir = await character();
  const sent: Sent[] = [];
  expect(await pushToUser(dir, "Shore - ada", "I miss you.", { ...PHONE, topic: "" }, T0, sender(sent))).toEqual({ kind: "not_set_up" });
  expect(sent).toEqual([]);

  const down = pushToUser(dir, "Shore - ada", "I miss you.", PHONE, T0, async () => { throw new Error("ntfy returned 503"); });
  expect(await rejectionOf(down)).toMatchObject({ message: "ntfy returned 503" });
  expect(await pushToUser(dir, "Shore - ada", "I miss you.", PHONE, T0 + 1, sender(sent))).toEqual({ kind: "sent", nextAt: T0 + 1 + DAY });
});

test("a push is cut at 300 characters, counting characters and not bytes", async () => {
  const dir = await character();
  const sent: Sent[] = [];
  await pushToUser(dir, "t", "🕯".repeat(300), { ...PHONE, everyMs: 0 }, T0, sender(sent));
  await pushToUser(dir, "t", "🕯".repeat(301), { ...PHONE, everyMs: 0 }, T0, sender(sent));
  expect(sent.map((each) => each.body)).toEqual(["🕯".repeat(300), `${"🕯".repeat(300)}…`]);
});

test("a record of the last push that can't be read counts as never having pushed", async () => {
  const dir = await character();
  const sent: Sent[] = [];
  for (const state of ["{not json", JSON.stringify({ last: "last Tuesday" }), JSON.stringify({ last: T0 }), "[]"]) {
    writeCharacterState(dir, "push.json", state);
    expect(await pushToUser(dir, "t", "hello", PHONE, T0 + 1, sender(sent)), state).toEqual({ kind: "sent", nextAt: T0 + 1 + DAY });
  }
  writeCharacterState(dir, "push.json", JSON.stringify({ last: new Date(T0).toISOString() }));
  expect(await pushToUser(dir, "t", "hello", PHONE, T0 + 1, sender(sent))).toEqual({ kind: "too_soon", lastAt: T0, nextAt: T0 + DAY });
});

test("the push topic and wait are read from [notifications], and described in the config schema", async () => {
  const root = await mkdtemp(testTmp("shore-push-config-"));
  const read = async (toml: string): Promise<[string, number]> => {
    await Bun.write(join(root, "config.toml"), toml);
    const notifications = loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} }).app.notifications;
    return [notifications.push_topic, Number(notifications.push_every.asSecs())];
  };
  expect(await read('[chat]\ndisplay_name = "eve"\n')).toEqual(["", 86_400]);
  expect(await read('[notifications]\npush_topic = "phone"\npush_every = "12h"\n')).toEqual(["phone", 43_200]);

  const described = configSchema({ instancesAt: () => [] }).filter((entry) => entry.key.startsWith("notifications.push_")).map((entry) => [entry.key, (entry.description ?? "").split(" ").slice(0, 3).join(" ")]);
  expect(described).toEqual([["notifications.push_every", "Least time between"], ["notifications.push_topic", "ntfy topic the"]]);
});
