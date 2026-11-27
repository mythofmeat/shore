import { describe, expect, spyOn, test } from "bun:test";

import { useApp } from "./app.ts";
import { acting, mount } from "./dom.ts";

const CODE = "c".repeat(43);
const app = useApp(`http://shore.test:7340/workspace/ada/story?from=phone#login=${CODE}`);

describe("opening a sign-in link", () => {
  test("signs in with the link's code, takes it out of the address bar, and lands on the sign-in page saying why when the code is spent", async () => {
    const { App } = await import("../../src/browser/app/App.tsx");
    const original = globalThis.fetch;
    const asked: string[] = [];
    const fetching = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (!path.endsWith("/api/login")) return await original(input, init);
      asked.push(typeof init?.body === "string" ? init.body : "");
      return Response.json({ code: "unauthorized", message: "Unknown or expired sign-in code" }, { status: 401 });
    }) as typeof fetch);
    app.restores.push(() => { fetching.mockRestore(); });
    const view = await mount(<App />);
    await acting(() => Bun.sleep(5));
    expect([asked, location.href]).toEqual([[JSON.stringify({ token: CODE })], "http://shore.test:7340/workspace/ada/story?from=phone"]);
    expect([view.host.querySelector("h1")?.textContent, view.host.querySelector("[role=alert]")?.textContent]).toEqual([
      "Connect to your daemon", "This sign-in link has expired or was already used. Show a new code on a signed-in device, or run shore devices link on the daemon’s machine.",
    ]);
    await view.unmount();
  });
});
