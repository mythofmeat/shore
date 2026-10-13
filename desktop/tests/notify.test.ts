import { expect, test } from "bun:test";
import { dockBadge, notificationArgs, OSASCRIPT } from "../src/notify.ts";

test("notificationArgs hands the text to AppleScript as arguments, so quotes and dashes stay text", () => {
  const title = "-e Nova";
  const body = "\" & (do shell script \"touch /tmp/pwned\") & \"";
  const args = notificationArgs(title, body);
  expect(args.slice(-3)).toEqual(["--", title, body]);
  expect(args.slice(0, -3).join(" ")).not.toContain("Nova");
});

test.skipIf(process.platform !== "darwin")("osascript reads the title and body back exactly", () => {
  const args = notificationArgs("-e Nova", "say \"hi\" & bye").map((arg) => arg.replace("display notification (item 2 of argv) with title (item 1 of argv)", "return (item 1 of argv) & \"|\" & (item 2 of argv)"));
  const result = Bun.spawnSync([OSASCRIPT, ...args]);
  expect(result.stdout.toString().trim()).toBe("-e Nova|say \"hi\" & bye");
});

test("dockBadge shows the unread count and clears at zero", () => {
  expect(dockBadge(3)).toBe("3");
  expect(dockBadge(0)).toBe("");
});
