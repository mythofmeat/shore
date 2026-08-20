import { describe, expect, test } from "bun:test";

import { OpenAIEmbedder } from "../src/llm/embed.ts";

function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) return;
      signal.addEventListener("abort", () => {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error("aborted"));
      });
    })) as unknown as typeof fetch;
}

describe("the embedder gives up on a provider that never answers", () => {
  test("a request that never settles becomes a transport error, not a hang", async () => {
    const embedder = new OpenAIEmbedder("m", "k", undefined, undefined, hangingFetch(), "id", 10);

    const failure = await embedder.embed(["one"]).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(failure).toMatchObject({ kind: "transport" });
  });

  test("the request carries a signal so a stalled socket cannot wedge the indexer", async () => {
    let seen: AbortSignal | null | undefined;
    const capturing = ((_url: string, init?: RequestInit) => {
      seen = init?.signal;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    await new OpenAIEmbedder("m", "k", undefined, undefined, capturing).embed(["one"]);

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });
});
