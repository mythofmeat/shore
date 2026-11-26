import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/run.ts";
import type { SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { required } from "../src/util/required.ts";
import { DEVICES_FILE } from "../src/web/devices.ts";
import { PROMPT_LIST_TOML } from "./support/prompt_list.ts";

const TOKEN = "http-api-owner-token";
const running: RunningDaemon[] = [];
afterEach(async () => {
  for (const started of running.splice(0)) {
    started.stop();
    await started.done;
  }
});

function replying(text: string): SidecarProvider {
  return {
    async *stream(request: SidecarRequest) {
      yield { type: "start", model: request.model };
      yield { type: "text", text };
      yield {
        type: "done", content: text, finish_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    },
    generate: () => { throw new Error("this test never calls generate"); },
  } as unknown as SidecarProvider;
}

interface Place { origin: string; dataDir: string }

async function daemon(provider?: SidecarProvider): Promise<Place> {
  const root = await mkdtemp(join(tmpdir(), "shore-http-api-"));
  const configDir = join(root, "config");
  for (const name of ["ada", "bo"]) {
    const workspace = join(configDir, "characters", name, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), `# ${name}\n`);
  }
  const configPath = join(configDir, "shore.toml");
  await writeFile(configPath, `[chat]\nmodel = "anthropic:claude-opus-4-8"\nmax_retries = 0\n[providers.anthropic]\napi_key_env = "SHORE_TEST_KEY"\n${PROMPT_LIST_TOML}[daemon.web]\nenabled = true\nbind_addr = "127.0.0.1:0"\n`);
  const started = await startDaemon({
    argv: ["--config", configPath, "--addr", "127.0.0.1:0"],
    env: {
      XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
      XDG_RUNTIME_DIR: join(root, "runtime"), HOME: root, SHORE_TEST_KEY: "sk-test", SHORE_TOKEN: TOKEN,
    },
    providers: provider === undefined ? {} : { anthropic: provider },
    instancesPath: join(root, "instances.json"), watchConfig: false, autoDiscovery: false,
  });
  running.push(started);
  return { origin: required(started.web).origin, dataDir: started.runtime.config.dirs.data };
}

function post(place: Place, path: string, credential: string | undefined, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${place.origin}${path}`, {
    method: "POST",
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function automationKey(place: Place, operations: readonly string[], name = "Phone"): Promise<{ id: string; token: string }> {
  const answer = await post(place, "/api/devices/automation", TOKEN, { name, operations });
  expect(answer.status).toBe(200);
  const created = await answer.json() as { device: { id: string; kind: string; operations: string[] }; token: string };
  expect(created.device).toMatchObject({ kind: "automation", operations: [...operations].sort() });
  return { id: created.device.id, token: created.token };
}

async function lines(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text()).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("running an operation over HTTP", () => {
  test("an automation key runs the operations it was given, with no Origin header, and nothing else", async () => {
    const place = await daemon();
    const key = await automationKey(place, ["presence"]);

    const set = await post(place, "/api/op/presence", key.token, { on: ["at home"] });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { statuses: { status: string }[] }).statuses.map((entry) => entry.status)).toEqual(["at home"]);

    for (const [path, body] of [["/api/op/status", {}], ["/api/devices/list", undefined], ["/api/login-code", undefined], ["/api/devices/automation", { name: "more", operations: ["status"] }]] as const) {
      const refused = await post(place, path, key.token, body);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("forbidden");
    }
    const socket = await fetch(`${place.origin}/api/swp`, { headers: { authorization: `Bearer ${key.token}` } });
    expect(socket.status).toBe(403);

    expect((await post(place, "/api/devices/revoke", TOKEN, { id: key.id })).status).toBe(204);
    const revoked = await post(place, "/api/op/presence", key.token, {});
    expect(revoked.status).toBe(401);
  });

  test("keys are kept on disk as digests, owner-only, and survive a restart of their store", async () => {
    const place = await daemon();
    const key = await automationKey(place, ["presence", "status"], "Home Assistant");
    const path = join(place.dataDir, DEVICES_FILE);
    const stored = await readFile(path, "utf8");
    expect(stored).not.toContain(key.token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const listed = await (await post(place, "/api/devices/list", TOKEN)).json() as { devices: { id: string; name: string; kind: string; current: boolean }[] };
    expect(listed.devices.find((device) => device.id === key.id)).toMatchObject({ name: "Home Assistant", kind: "automation", current: false });
  });

  test("a key can't be made for nothing, for an operation that doesn't exist, or for one that only a connection can run", async () => {
    const place = await daemon();
    for (const operations of [[], ["no_such_operation"], ["switch_thread"]]) {
      const refused = await post(place, "/api/devices/automation", TOKEN, { name: "Phone", operations });
      expect(refused.status).toBe(400);
    }
    expect((await post(place, "/api/devices/automation", TOKEN, { name: " ", operations: ["presence"] })).status).toBe(400);
  });

  test("a command's answer is its result, and a failure is its code and message under the matching HTTP status", async () => {
    const place = await daemon();
    const listed = await post(place, "/api/op/list_characters", TOKEN, {});
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain("\"ada\"");

    const wrong = await post(place, "/api/op/thread_label?character=ada", TOKEN, { label: "missing its name" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "invalid_request" });

    const missing = await post(place, "/api/op/thread_label?character=ada", TOKEN, { name: "nowhere", label: "x" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });

    const unknown = await post(place, "/api/op/no_such_operation", TOKEN, {});
    expect(unknown.status).toBe(404);
    const connectionOnly = await post(place, "/api/op/switch_character", TOKEN, { name: "bo" });
    expect(connectionOnly.status).toBe(400);
    expect(((await connectionOnly.json()) as { message: string }).message).toContain("?character=");
    const notJson = await post(place, "/api/op/status", TOKEN, undefined, { "content-type": "text/plain", "content-length": "3" });
    expect(notJson.status).toBe(400);
    const credential = await post(place, "/api/op/status", "not-a-credential", {});
    expect(credential.status).toBe(401);
  });

  test("the character and thread come from the query string, so they never collide with an operation's own arguments", async () => {
    const place = await daemon();
    expect((await post(place, "/api/op/create_thread?character=bo", TOKEN, { name: "garden" })).status).toBe(200);
    const bo = await (await post(place, "/api/op/list_threads?character=bo", TOKEN, {})).json() as { threads: { id: string }[] };
    expect(bo.threads.map((thread) => thread.id)).toContain("garden");
    const ada = await (await post(place, "/api/op/list_threads?character=ada", TOKEN, {})).json() as { threads: { id: string }[] };
    expect(ada.threads.map((thread) => thread.id)).not.toContain("garden");
  });

  test("a request talks in the thread it names, a thread that doesn't exist means the home thread, and an unknown character means none", async () => {
    const place = await daemon(replying("noted"));
    const nobody = await post(place, "/api/op/list_threads?character=nobody", TOKEN, {});
    expect(nobody.status).toBe(400);
    expect(((await nobody.json()) as { message: string }).message).toContain("multiple characters");
    expect((await post(place, "/api/op/create_thread?character=ada", TOKEN, { name: "garden" })).status).toBe(200);
    expect((await post(place, "/api/op/message?character=ada&thread=garden", TOKEN, { text: "in the garden", stream: false })).status).toBe(200);
    expect((await post(place, "/api/op/message?character=ada&thread=nowhere", TOKEN, { text: "at home", stream: false })).status).toBe(200);
    const contents = async (query: string) => ((await (await post(place, `/api/op/log?${query}`, TOKEN, {})).json()) as { messages: { content: string }[] }).messages.map((message) => message.content);
    expect(await contents("character=ada&thread=garden")).toEqual(["in the garden", "noted"]);
    expect(await contents("character=ada")).toEqual(["at home", "noted"]);
  });

  test("a message streams its frames one JSON object per line when asked, and otherwise answers how it finished", async () => {
    const place = await daemon(replying("hello there"));
    const streamed = await post(place, "/api/op/message?character=ada", TOKEN, { text: "hi", stream: true }, { accept: "application/x-ndjson" });
    expect(streamed.headers.get("content-type")).toBe("application/x-ndjson");
    const frames = await lines(streamed);
    const types = frames.map((frame) => frame["type"]);
    expect(types).toContain("stream_start");
    expect(types.at(-1)).toBe("request_finished");
    expect(frames.at(-1)).toMatchObject({ outcome: "completed" });
    expect(frames.filter((frame) => frame["type"] === "stream_chunk").map((frame) => frame["text"]).join("")).toBe("hello there");
    expect(new Set(frames.map((frame) => frame["rid"]))).toEqual(new Set([frames[0]?.["rid"]]));

    const answered = await post(place, "/api/op/message?character=ada", TOKEN, { text: "again", stream: false });
    expect(await answered.json()).toMatchObject({ type: "request_finished", outcome: "completed" });

    const log = await (await post(place, "/api/op/log?character=ada", TOKEN, { count: 10 })).json() as { messages: { content: string }[] };
    expect(log.messages.map((message) => message.content)).toEqual(["hi", "hello there", "again", "hello there"]);
  });

  test("a reply that fails ends the request with the failure's code, message and HTTP status", async () => {
    const failing = { async *stream() { yield* []; throw new Error("the model fell over"); }, generate: () => { throw new Error("unused"); } } as unknown as SidecarProvider;
    const place = await daemon(failing);
    const failed = await post(place, "/api/op/message?character=ada", TOKEN, { text: "hi", stream: false });
    expect(failed.status).toBe(500);
    const problem = await failed.json() as { code: string; message: string };
    expect(problem.code).toBe("internal_error");
    expect(problem.message).toContain("the model fell over");
    const streamed = await lines(await post(place, "/api/op/message?character=ada", TOKEN, { text: "hi", stream: true }, { accept: "application/x-ndjson" }));
    expect(streamed.map((frame) => frame["type"]).slice(-2)).toEqual(["error", "request_finished"]);
    expect(streamed.at(-1)).toMatchObject({ outcome: "failed" });
  });

  test("stopping work answers at once", async () => {
    const place = await daemon();
    const stopped = await post(place, "/api/op/cancel?character=ada", TOKEN);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toBeNull();
  });
});

describe("a browser's own requests", () => {
  test("a signed-in browser can run an operation from its page, and nothing without a page can use its cookie", async () => {
    const place = await daemon();
    const code = await (await post(place, "/api/login-code", TOKEN)).json() as { code: string };
    const login = await fetch(`${place.origin}/api/login`, {
      method: "POST", headers: { origin: place.origin, "content-type": "application/json", "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" },
      body: JSON.stringify({ token: code.code }),
    });
    expect(login.status).toBe(200);
    const cookie = required(login.headers.get("set-cookie")).split(";")[0] ?? "";
    const fromPage = await post(place, "/api/op/list_characters", undefined, {}, { origin: place.origin, cookie });
    expect(fromPage.status).toBe(200);
    const withoutPage = await post(place, "/api/op/list_characters", undefined, {}, { cookie });
    expect(withoutPage.status).toBe(403);

    const listed = await (await post(place, "/api/devices/list", undefined, undefined, { origin: place.origin, cookie })).json() as { devices: { kind: string; name: string; current: boolean; id: string }[] };
    const browser = required(listed.devices.find((device) => device.kind === "browser"));
    expect(browser).toMatchObject({ name: "Firefox on Linux", current: true });
    expect((await post(place, "/api/devices/revoke", TOKEN, { id: browser.id })).status).toBe(204);
    expect((await post(place, "/api/op/list_characters", undefined, {}, { origin: place.origin, cookie })).status).toBe(401);
  });
});

describe("signing in a CLI from a device that's already in", () => {
  const secret = "s".repeat(40);

  async function start(place: Place, name = "desktop", given = secret): Promise<Response> {
    return await post(place, "/api/sign-in", undefined, { name, secret: given });
  }

  test("the CLI waits until someone signed in allows its code, then gets a credential of its own once", async () => {
    const place = await daemon();
    const pending = await (await start(place)).json() as { id: string; code: string };
    expect(pending.code).toMatch(/^[A-Z2-9]{4}$/);
    const poll = () => post(place, `/api/sign-in/${pending.id}`, undefined, { secret });

    expect((await poll()).status).toBe(202);
    const listed = await (await post(place, "/api/devices/list", TOKEN)).json() as { requests: { code: string; name: string }[] };
    expect(listed.requests.map(({ code, name }) => ({ code, name }))).toEqual([{ code: pending.code, name: "desktop" }]);
    expect((await post(place, `/api/sign-in/${pending.id}`, undefined, { secret: "x".repeat(40) })).status).toBe(404);

    expect((await post(place, "/api/devices/decide", TOKEN, { code: pending.code.toLowerCase(), allow: true })).status).toBe(204);
    const granted = await poll();
    expect(granted.status).toBe(200);
    const { token } = await granted.json() as { token: string };
    expect((await poll()).status).toBe(404);

    const status = await post(place, "/api/op/status?character=ada", token, {});
    expect(status.status).toBe(200);
    const devices = await (await post(place, "/api/devices/list", token)).json() as { devices: { kind: string; name: string; current: boolean }[]; requests: unknown[] };
    expect(devices.devices.find((device) => device.kind === "cli")).toMatchObject({ name: "desktop", current: true });
    expect(devices.requests).toEqual([]);
  });

  test("a refused CLI is told so, and a code nobody is waiting with changes nothing", async () => {
    const place = await daemon();
    const pending = await (await start(place)).json() as { id: string; code: string };
    expect((await post(place, "/api/devices/decide", TOKEN, { code: "ZZZZ", allow: true })).status).toBe(404);
    expect((await post(place, "/api/devices/decide", TOKEN, { code: pending.code, allow: false })).status).toBe(204);
    const refused = await post(place, `/api/sign-in/${pending.id}`, undefined, { secret });
    expect(refused.status).toBe(403);
    expect((await post(place, `/api/sign-in/${pending.id}`, undefined, { secret })).status).toBe(404);
  });

  test("only a few devices can wait at once, a short secret is refused, and an automation key can't let anyone in", async () => {
    const place = await daemon();
    expect((await start(place, "desktop", "short")).status).toBe(400);
    for (let waiting = 0; waiting < 4; waiting += 1) expect((await start(place, `cli ${String(waiting)}`)).status).toBe(200);
    expect((await start(place, "one too many")).status).toBe(429);
    const key = await automationKey(place, ["presence"]);
    expect((await post(place, "/api/devices/decide", key.token, { code: "AAAA", allow: true })).status).toBe(403);
    const elsewhere = await post(place, "/api/sign-in", undefined, { name: "x", secret }, { "sec-fetch-site": "cross-site" });
    expect(elsewhere.status).toBe(403);
  });
});
