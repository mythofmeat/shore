import { expect, test } from "bun:test";

import type { ImageRef } from "../../src/protocol/ImageRef.ts";
import { acting, mount, useDom } from "./dom.ts";

useDom();

test("a sent video the browser cannot play gives way to its name, with the video icon and the reason", async () => {
  const { SentPicture } = await import("../../src/browser/pictures.tsx");
  const { Icon } = await import("../../src/browser/ui/icons.tsx");
  const clip: ImageRef = { path: "/data/media/ada/sent/abc.mp4", embed: "![[tide.mp4]]", name: "tide.mp4" };
  const view = await mount(<SentPicture image={clip} open={() => {}} />);
  const player = view.host.querySelector("video");
  expect(player?.getAttribute("src")).toBe("/api/pictures/abc.mp4");
  expect(player?.getAttribute("aria-label")).toBe("tide.mp4");
  expect(view.host.querySelector(".picture-name")).toBeNull();

  await acting(() => { player?.dispatchEvent(new Event("error")); });
  expect(view.host.querySelector("video")).toBeNull();
  const name = view.host.querySelector(".picture-name");
  expect(name?.textContent).toBe("tide.mp4");
  expect(name?.getAttribute("title")).toBe("This video can’t play here");
  const icon = await mount(<Icon name="video" size={14} />);
  expect(name?.querySelector("svg")?.outerHTML).toBe(icon.host.innerHTML);
});
