import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, test } from "bun:test";

import { CallStore } from "../src/call_store.ts";
import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import {
  CassetteMiss,
  CassettePlayer,
  canonicalBody,
  installCassettePlayer,
  keyOrdered,
  replayableHeaders,
  requestDiff,
  snapshotOf,
  type Cassette,
} from "../src/testing/cassette.ts";
import { cassetteFromCallStore } from "../src/testing/cassette_store.ts";
import { installWireCapture, newWireScope, withWireScope } from "../src/llm/wire_capture.ts";
import { startMockAnthropic, type MockAnthropic } from "../src/testing/mock_anthropic.ts";
import type { SidecarRequest } from "../src/llm/types.ts";

let mock: MockAnthropic | undefined;
const teardown: Array<() => void> = [];

afterEach(async () => {
  for (const t of teardown.splice(0)) t();
  await mock?.stop();
  mock = undefined;
});

function exchange(body: string, response: string, url = "https://api.anthropic.com/v1/messages") {
  return {
    method: "POST",
    url,
    request_headers: [
      ["content-type", "application/json"],
      ["x-api-key", "[redacted]"],
    ] as [string, string][],
    request_body: body,
    status: 200,
    status_text: "OK",
    response_headers: [["content-type", "application/json"]] as [string, string][],
    response_body: response,
  };
}

describe("the canonical request snapshot", () => {
  test("key order in the body does not change the identity", () => {
    expect(keyOrdered({ b: 1, a: { d: 2, c: 3 } })).toEqual({ a: { c: 3, d: 2 }, b: 1 });
    expect(canonicalBody('{"b":1,"a":2}')).toEqual(canonicalBody('{"a":2,"b":1}'));
  });

  test("array order does change it, because message order is meaning", () => {
    expect(canonicalBody('{"m":[1,2]}')).not.toEqual(canonicalBody('{"m":[2,1]}'));
  });

  test("a non-JSON body is compared as-is rather than thrown on", () => {
    expect(canonicalBody("not json at all")).toBe("not json at all");
    expect(canonicalBody(null)).toBeNull();
  });

  test("headers are allow-listed, so a rotated key is not a cassette miss", () => {
    const kept = replayableHeaders([
      ["Content-Type", "application/json"],
      ["x-api-key", "sk-live-1"],
      ["user-agent", "shore/1"],
      ["anthropic-version", "2023-06-01"],
    ]);
    expect(kept).toEqual([
      ["anthropic-version", "2023-06-01"],
      ["content-type", "application/json"],
    ]);
  });
});

describe("requestDiff", () => {
  test("names the field that diverged, not just that something did", () => {
    const recorded = snapshotOf("POST", "https://x/y", [], '{"model":"opus","max_tokens":8}');
    const sent = snapshotOf("POST", "https://x/y", [], '{"model":"sonnet","max_tokens":8}');

    expect(requestDiff(recorded, sent)).toEqual(['body.model: recorded "opus", got "sonnet"']);
  });

  test("reports a field that appeared and one that vanished", () => {
    const recorded = snapshotOf("POST", "https://x/y", [], '{"a":1}');
    const sent = snapshotOf("POST", "https://x/y", [], '{"b":2}');
    const diff = requestDiff(recorded, sent);

    expect(diff).toContain("body.a: recorded 1, missing");
    expect(diff).toContain("body.b: not recorded, got 2");
  });

  test("an identical request diffs to nothing", () => {
    const one = snapshotOf("POST", "https://x/y", [], '{"a":[1,2]}');
    const two = snapshotOf("POST", "https://x/y", [], '{"a":[1,2]}');
    expect(requestDiff(one, two)).toEqual([]);
  });
});

describe("sequential selection", () => {
  test("the same request twice in one cassette plays its two answers in order", () => {
    const cassette: Cassette = {
      name: "twice",
      exchanges: [exchange('{"n":1}', '{"reply":"first"}'), exchange('{"n":1}', '{"reply":"second"}')],
    };
    const player = new CassettePlayer(cassette);
    const snapshot = snapshotOf(
      "POST",
      "https://api.anthropic.com/v1/messages",
      [["content-type", "application/json"]],
      '{"n":1}',
    );

    expect(player.match(snapshot).response_body).toBe('{"reply":"first"}');
    expect(player.match(snapshot).response_body).toBe('{"reply":"second"}');
    expect(player.match(snapshot).response_body).toBe('{"reply":"second"}');
    expect(player.remaining).toBe(0);
  });

  test("a miss carries the diff rather than a bare failure", () => {
    const player = new CassettePlayer({
      name: "one",
      exchanges: [exchange('{"model":"opus"}', "{}")],
    });

    try {
      player.match(
        snapshotOf(
          "POST",
          "https://api.anthropic.com/v1/messages",
          [["content-type", "application/json"]],
          '{"model":"sonnet"}',
        ),
      );
      throw new Error("expected a cassette miss");
    } catch (e) {
      expect(e).toBeInstanceOf(CassetteMiss);
      expect((e as CassetteMiss).diff).toContain('body.model: recorded "opus", got "sonnet"');
    }
  });
});

describe("record once, replay with nothing listening", () => {
  function request(url: string): SidecarRequest {
    return {
      sdk: "anthropic",
      provider_key: "anthropic",
      model: "claude-opus-5",
      api_key: "sk-test",
      base_url: url,
      max_tokens: 64,
      replay_prior_thinking: "all",
      provider_options: { cache_ttl: "1h" },
      system: [{ text: "x".repeat(6000), label: "system" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };
  }

  test("the second identical request reads the cache the first one wrote", async () => {
    mock = await startMockAnthropic({});
    const store = CallStore.openInMemory();
    const uninstall = installWireCapture((e) => store.recordHttpCall(e));
    teardown.push(uninstall);

    const provider = new AnthropicProvider();
    const req = request(mock.url);

    const firstUsage = await withWireScope(newWireScope("call-1", {}), async () => {
      return (await provider.generate(req)).usage;
    });
    const secondUsage = await withWireScope(newWireScope("call-2", {}), async () => {
      return (await provider.generate(request(required(mock).url))).usage;
    });

    expect(firstUsage.cache_creation_tokens).toBeGreaterThan(0);
    expect(secondUsage.cache_read_tokens).toBeGreaterThan(0);

    const cassette = cassetteFromCallStore(store, "call-2");
    expect(cassette.exchanges.length).toBeGreaterThan(0);

    uninstall();
    await mock.stop();
    const listening = mock;
    mock = undefined;

    const replay = installCassettePlayer(cassette);
    teardown.push(replay.uninstall);

    const replayed = (await provider.generate(request(listening.url))).usage;
    expect(replayed.cache_read_tokens).toBe(secondUsage.cache_read_tokens);
    expect(replay.player.remaining).toBe(0);
  });
});
