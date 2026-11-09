import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { electronZip, type GitHubHosts } from "../scripts/electron_zip.ts";

const VERSION = "1.2.3";
const FILE = `electron-v${VERSION}-darwin-arm64.zip`;
const WEB_PATH = `/electron/electron/releases/download/v${VERSION}/${FILE}`;
const RELEASE_PATH = `/repos/electron/electron/releases/tags/v${VERSION}`;
const ASSET_PATH = "/repos/electron/electron/releases/assets/7";
const ZIP = new TextEncoder().encode("the electron release zip");
const SHA256 = new Bun.CryptoHasher("sha256").update(ZIP).digest("hex");
const NO_WAIT = [0, 0, 0, 0, 0];

interface Seen {
  readonly path: string;
  readonly authorization: string | null;
}

interface FakeGitHub {
  readonly hosts: GitHubHosts;
  readonly seen: Seen[];
  stop(): void;
}

function fakeGitHub(web: () => Response, asset: () => Response = () => new Response(ZIP)): FakeGitHub {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { origin, pathname } = new URL(request.url);
      seen.push({ path: pathname, authorization: request.headers.get("authorization") });
      if (pathname === WEB_PATH) return web();
      if (pathname === RELEASE_PATH) return Response.json({ assets: [{ name: FILE, url: `${origin}${ASSET_PATH}` }] });
      if (pathname === ASSET_PATH && request.headers.get("accept") === "application/octet-stream") return asset();
      return new Response(null, { status: 404 });
    },
  });
  return { hosts: { api: server.url.origin, web: server.url.origin }, seen, stop: () => void server.stop(true) };
}

async function failureOf(download: Promise<Uint8Array>): Promise<string> {
  const outcome = await download.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("the download succeeded");
  return outcome.message;
}

const saved = { GITHUB_TOKEN: process.env["GITHUB_TOKEN"], GH_TOKEN: process.env["GH_TOKEN"] };
let github: FakeGitHub | undefined;

beforeEach(() => {
  delete process.env["GITHUB_TOKEN"];
  delete process.env["GH_TOKEN"];
});

afterEach(() => {
  github?.stop();
  github = undefined;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("downloading the Electron release zip", () => {
  test("a download github.com fails with a server error comes through the API instead", async () => {
    github = fakeGitHub(() => new Response("gateway timeout", { status: 504 }));
    expect(await electronZip(FILE, VERSION, SHA256, github.hosts, NO_WAIT)).toEqual(ZIP);
    expect(github.seen.map((s) => s.path)).toEqual([WEB_PATH, RELEASE_PATH, ASSET_PATH]);
  });

  test("a token in the environment goes with the API requests, so CI isn't held to the anonymous limit, and never to the github.com link", async () => {
    process.env["GITHUB_TOKEN"] = "ci-token";
    github = fakeGitHub(() => new Response(null, { status: 503 }));
    expect(await electronZip(FILE, VERSION, SHA256, github.hosts, NO_WAIT)).toEqual(ZIP);
    expect(github.seen).toEqual([
      { path: WEB_PATH, authorization: null },
      { path: RELEASE_PATH, authorization: "Bearer ci-token" },
      { path: ASSET_PATH, authorization: "Bearer ci-token" },
    ]);
  });

  test("bytes that don't match the electron package's checksum are never returned, from either source", async () => {
    github = fakeGitHub(() => new Response("tampered"), () => new Response("also tampered"));
    const message = await failureOf(electronZip(FILE, VERSION, SHA256, github.hosts, [0, 0, 0]));
    expect(message).toContain("don't match the checksum");
    expect(github.seen.filter((s) => s.path === WEB_PATH).length).toBe(2);
    expect(github.seen.filter((s) => s.path === ASSET_PATH).length).toBe(2);
  });

  test("a release file that doesn't exist fails at once instead of retrying", async () => {
    github = fakeGitHub(() => new Response(null, { status: 404 }));
    expect(await failureOf(electronZip(FILE, VERSION, SHA256, github.hosts, NO_WAIT))).toContain("no such release file");
    expect(github.seen.length).toBe(1);
  });

  test("after the last retry it gives up and names every failure", async () => {
    github = fakeGitHub(() => new Response(null, { status: 502 }), () => new Response(null, { status: 500 }));
    expect(await failureOf(electronZip(FILE, VERSION, SHA256, github.hosts, [0, 0]))).toBe(`Couldn't download ${FILE}: HTTP 502; HTTP 500; HTTP 502.`);
  });
});
