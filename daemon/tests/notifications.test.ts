import { expect, test } from "bun:test";

import { defaultNotificationsConfig, type NotificationsConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { NotificationService, type NotificationSink } from "../src/notifications.ts";
import { setTestEnv, unsetTestEnv } from "./support/env.ts";

function service(settings: Partial<NotificationsConfig>): { notifier: NotificationService; sent: unknown[][] } {
  const sent: unknown[][] = [];
  const sink: NotificationSink = {
    notifySend: async (...args) => { sent.push(["notify_send", ...args]); },
    ntfy: async (...args) => { sent.push(["ntfy", ...args]); },
    command: async (...args) => { sent.push(["command", ...args]); },
  };
  return { notifier: new NotificationService({ ...defaultNotificationsConfig(), ...settings }, sink), sent };
}

test("a new install delivers nothing, and turning delivery on sends only the events that are selected", () => {
  const off = service({});
  off.notifier.notify("message_complete", "Ada", "hello");
  expect(off.sent).toEqual([]);

  const on = service({ via: "notify_send" });
  on.notifier.notify("message_complete", "Ada", "hello");
  on.notifier.notify("autonomous_message", "Ada", "thinking of you", { path: "/p/cat.png", name: "cat.png" });
  on.notifier.notify("error", "Ada", "it broke");
  expect(on.sent).toEqual([
    ["notify_send", "Ada", "hello", undefined],
    ["notify_send", "Ada", "thinking of you", { path: "/p/cat.png", name: "cat.png" }],
  ]);

  const chosen = service({ via: "notify_send", events: ["error"] });
  chosen.notifier.notify("message_complete", "Ada", "hello");
  chosen.notifier.notify("error", "Ada", "it broke");
  expect(chosen.sent).toEqual([["notify_send", "Ada", "it broke", undefined]]);
});

test("ntfy delivery goes to the configured server and topic with the token from the named variable, and command delivery runs the configured command", () => {
  setTestEnv("SHORE_TEST_NTFY_TOKEN", "tk-1");
  const withToken = service({ via: "ntfy", url: "https://ntfy.example", topic: "shore", token_env: "SHORE_TEST_NTFY_TOKEN" });
  withToken.notifier.notify("message_complete", "Ada", "hello");
  expect(withToken.sent).toEqual([["ntfy", { url: "https://ntfy.example", topic: "shore", token: "tk-1" }, "Ada", "hello", undefined]]);

  unsetTestEnv("SHORE_TEST_NTFY_TOKEN");
  const unset = service({ via: "ntfy", topic: "shore", token_env: "SHORE_TEST_NTFY_TOKEN" });
  unset.notifier.notify("message_complete", "Ada", "hello");
  const open = service({ via: "ntfy", topic: "shore" });
  open.notifier.notify("message_complete", "Ada", "hello");
  expect([unset.sent, open.sent]).toEqual([
    [["ntfy", { url: "https://ntfy.sh", topic: "shore", token: "" }, "Ada", "hello", undefined]],
    [["ntfy", { url: "https://ntfy.sh", topic: "shore", token: "" }, "Ada", "hello", undefined]],
  ]);

  const command = service({ via: "command", command: ["say", "{title}"] });
  command.notifier.notify("message_complete", "Ada", "hello");
  expect(command.sent).toEqual([["command", ["say", "{title}"], "Ada", "hello"]]);
});

test("a finished reply is announced only when it took at least notifications.min_generation_duration, and a long body is cut short", () => {
  const any = service({ via: "notify_send" });
  any.notifier.notifyMessageComplete("Ada", "quick", 1);
  expect(any.sent).toEqual([["notify_send", "Ada", "quick", undefined]]);

  const slow = service({ via: "notify_send", min_generation_duration: ConfigDuration.fromSecs(30) });
  slow.notifier.notifyMessageComplete("Ada", "too quick", 29_999);
  slow.notifier.notifyMessageComplete("Ada", "long enough", 30_000, { path: "/p/a.png", name: "a.png" });
  slow.notifier.notifyMessageComplete("Ada", "é".repeat(150), 45_000);
  expect(slow.sent).toEqual([
    ["notify_send", "Ada", "long enough", { path: "/p/a.png", name: "a.png" }],
    ["notify_send", "Ada", `${"é".repeat(100)}…`, undefined],
  ]);

  const unselected = service({ via: "notify_send", events: ["error"] });
  unselected.notifier.notifyMessageComplete("Ada", "done", 60_000);
  expect(unselected.sent).toEqual([]);
});
