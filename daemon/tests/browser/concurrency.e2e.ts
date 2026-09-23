import { connect } from "node:net";
import { expect, test } from "./fixtures.ts";
import type { ServerMessage } from "../../src/protocol/ServerMessage.ts";

test("TCP and browser edits converge while switching away from an active stream keeps threads separate", async ({ page, tcpPort }) => {
  await page.goto("/workspace");
  await page.getByLabel("Daemon token").fill("browser-test-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Character name", { exact: true }).fill("nova");
  await dialog.getByRole("button", { name: "Run action", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("navigation", { name: "Characters" }).getByRole("button", { name: "N nova" }).click();
  await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
  const socket = connect({ host: "127.0.0.1", port: tcpPort });
  const frames: ServerMessage[] = [];
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (text: string) => {
    buffered += text;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      if (line.trim() !== "") frames.push(JSON.parse(line) as ServerMessage);
    }
  });
  const send = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
  const finished = async (rid: string) => {
    await expect.poll(() => frames.find((frame) => frame.type === "request_finished" && frame.rid === rid)).toMatchObject({ outcome: "completed" });
  };
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    send({ type: "hello", client_type: "tui", client_name: "browser-concurrency", capabilities: ["request-lifecycle"], character: "nova", token: "browser-test-token" });
    await expect.poll(() => frames.some((frame) => frame.type === "history")).toBe(true);
    send({ type: "message", rid: "native-message", text: "Written through native TCP", stream: true });
    await finished("native-message");
    const user = page.getByRole("article", { name: "user message" }).filter({ hasText: "Written through native TCP" });
    await expect(user).toBeVisible();
    await user.getByRole("button", { name: "Edit", exact: true }).click();
    await dialog.getByLabel("Message text", { exact: true }).fill("Edited through the browser");
    await dialog.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Action completed" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect.poll(() => frames.some((frame) => frame.type === "history" && frame.messages.some((message) => message.content === "Edited through the browser"))).toBe(true);
    const history = frames.findLast((frame) => frame.type === "history");
    const message = history?.type === "history" ? history.messages.find((item) => item.content === "Edited through the browser") : undefined;
    if (message === undefined) throw new Error("Missing edited native history");
    send({ type: "command", rid: "native-edit", name: "edit", args: { ref: message.msg_id, content: "Edited again through TCP" } });
    await finished("native-edit");
    await expect(page.getByRole("article", { name: "user message" }).filter({ hasText: "Edited again through TCP" })).toBeVisible();
    send({ type: "command", rid: "create-side", name: "create_thread", args: { name: "side" } });
    await finished("create-side");
    await page.reload();
    await page.getByLabel("Message", { exact: true }).fill("hold this request on main");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("article", { name: "Streaming response" })).toBeVisible();
    await page.getByRole("navigation", { name: "Threads" }).getByRole("button", { name: /side/ }).click();
    await expect(page.getByRole("heading", { name: "nova / side" })).toBeVisible();
    await expect(page.getByRole("article", { name: "Streaming response" })).toHaveCount(0);
    await expect(page.getByRole("article", { name: "user message" })).toHaveCount(0);
    await page.getByLabel("Message", { exact: true }).fill("Side conversation stays independent");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("article", { name: "assistant message" })).toContainText("Side conversation stays independent");
    await expect(page.getByRole("article", { name: "assistant message" })).not.toContainText("main");
    await page.getByRole("navigation", { name: "Threads" }).getByRole("button", { name: /main/ }).click();
    await expect(page.getByRole("heading", { name: "nova / main" })).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("article", { name: "user message" }).filter({ hasText: "Edited again through TCP" })).toBeVisible();
    await expect(page.getByRole("article", { name: "user message" }).filter({ hasText: "Side conversation" })).toHaveCount(0);
  } finally { socket.destroy(); }
});
