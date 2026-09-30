import { describe, expect, test } from "bun:test";

import { OrderedDelivery } from "../src/handler/generation.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { outcomeOf } from "./support/outcome.ts";

const frame = (name: string): ServerMessage => ({
  type: "command_output",
  rid: null,
  name,
  data: {},
});

describe("generation frame delivery", () => {
  test("serializes frames and flushes every accepted send", async () => {
    const order: string[] = [];
    const delivery = new OrderedDelivery(async (message) => {
      if (message.type !== "command_output") throw new Error("unexpected frame");
      order.push(`start:${message.name}`);
      await Promise.resolve();
      order.push(`end:${message.name}`);
    });

    void delivery.send(frame("one"));
    void delivery.send(frame("two"));
    await delivery.flush();

    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  test("does not erase a failed write and still drains later frames", async () => {
    const delivered: string[] = [];
    const delivery = new OrderedDelivery(async (message) => {
      if (message.type !== "command_output") throw new Error("unexpected frame");
      if (message.name === "bad") throw new Error("socket closed");
      delivered.push(message.name);
    });

    void delivery.send(frame("bad"));
    void delivery.send(frame("after"));

    expect(await outcomeOf(delivery.flush())).toThrow("failed to deliver");
    expect(delivered).toEqual(["after"]);
  });
});
