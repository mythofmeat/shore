import { describe, expect, test } from "bun:test";

import { MediaDownloadError, readMediaResponse } from "../src/connections/matrix/bot.ts";
import { rejectionOf } from "./support/outcome.ts";

function chunked(chunks: readonly Uint8Array[], headers?: Record<string, string>): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    }),
    headers === undefined ? {} : { headers },
  );
}

describe("bounded Matrix media responses", () => {
  test("rejects an oversized declared body before reading it", async () => {
    const response = chunked([new Uint8Array([1])], { "content-length": "101" });
    expect(await rejectionOf(readMediaResponse(response, 100))).toMatchObject({
      name: "MediaDownloadError",
      reason: "too_large",
    });
  });

  test("rejects a declared size too large to represent safely", async () => {
    const response = chunked([], { "content-length": "999999999999999999999999" });
    expect(await rejectionOf(readMediaResponse(response, 100))).toMatchObject({ reason: "too_large" });
  });

  test("rejects an oversized undeclared chunked body", async () => {
    const response = chunked([new Uint8Array(60), new Uint8Array(41)]);
    expect(await rejectionOf(readMediaResponse(response, 100))).toMatchObject({
      name: "MediaDownloadError",
      reason: "too_large",
    });
  });

  test("combines a bounded chunked body exactly", async () => {
    const response = chunked([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    expect(await readMediaResponse(response, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("cancels a slow body at the deadline", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
      }),
    );
    try {
      await readMediaResponse(response, 100, 5);
      throw new Error("expected the response to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaDownloadError);
      expect((error as MediaDownloadError).reason).toBe("timed_out");
    }
  });
});
