import { afterEach, describe, expect, jest, test } from "bun:test";

import { acting, button, click, mount, useDom } from "./dom.ts";

useDom();

afterEach(() => {
  jest.useRealTimers();
  document.body.replaceChildren();
});

describe("icons", () => {
  test("are hidden from readers, sized as asked, outlined in a weight chosen per icon or filled", async () => {
    const { Icon } = await import("../../src/browser/ui/icons.tsx");
    const view = await mount(<><Icon name="plus" /><Icon name="close" size={12} className="mine" /></>);
    const [plus, close] = [...view.host.querySelectorAll("svg")];
    expect([plus?.getAttribute("width"), plus?.getAttribute("height"), plus?.getAttribute("viewBox"), plus?.getAttribute("aria-hidden"), plus?.getAttribute("focusable"), plus?.hasAttribute("class")]).toEqual(["18", "18", "0 0 24 24", "true", "false", false]);
    expect([close?.getAttribute("width"), close?.getAttribute("class")]).toEqual(["12", "mine"]);
    const weights = { chevronDown: "2", chevronUp: "2", chevronLeft: "2", chevronRight: "2", check: "2", send: "2.2", more: "0", stop: "0", plus: "1.75", trash: "1.75" } as const;
    for (const [name, weight] of Object.entries(weights)) {
      const one = await mount(<Icon name={name as keyof typeof weights} />);
      const svg = one.host.querySelector("svg");
      const filled = weight === "0";
      expect([svg?.getAttribute("stroke-width"), svg?.getAttribute("fill"), svg?.getAttribute("stroke"), (svg?.children.length ?? 0) > 0], name).toEqual([weight, filled ? "currentColor" : "none", filled ? "none" : "currentColor", true]);
      await one.unmount();
    }
  });
});

describe("avatars", () => {
  test("take a steady tone from the name and show its first character, or a question mark", async () => {
    const { avatarTone, initial } = await import("../../src/browser/ui/avatar.tsx");
    expect(["ada", "bo", "cy", "Shore", "qifei", "😀x", "a much longer name that wraps the hash around"].map(avatarTone)).toEqual([0, 5, 4, 3, 4, 4, 0]);
    expect(["  bo", "ñandu", "👩‍👩‍👧 family", "ß", "", "   "].map(initial)).toEqual(["B", "Ñ", "👩‍👩‍👧", "SS", "?", "?"]);
  });

  test("show a picture when there is one, else the initial in its tone, sized as asked", async () => {
    const { Avatar, UserAvatar } = await import("../../src/browser/ui/avatar.tsx");
    const view = await mount(<>
      <Avatar name="ada" />
      <Avatar name="bo" size={50} selected />
      <Avatar name="cy" avatar={{ mime_type: "image/png", data: "iVBOR" }} />
      <Avatar name="dee" avatar={{ mime_type: "image/png", data: "iVBOR" }} selected size={20} />
      <Avatar name="eve" avatar={null} />
      <UserAvatar />
      <UserAvatar size={20} />
    </>);
    const [ada, bo, cy, dee, eve, user, small] = [...view.host.children] as HTMLElement[];
    expect([ada?.tagName, ada?.className, ada?.dataset["tone"], ada?.textContent, ada?.getAttribute("aria-hidden"), ada?.style.width, ada?.style.height, ada?.style.fontSize]).toEqual(["SPAN", "avatar ", "0", "A", "true", "36px", "36px", "15px"]);
    expect([bo?.className, bo?.style.width, bo?.style.fontSize]).toEqual(["avatar selected", "50px", "21px"]);
    expect([cy?.tagName, cy?.className, cy?.getAttribute("src"), cy?.getAttribute("alt"), cy?.style.width]).toEqual(["IMG", "avatar ", "data:image/png;base64,iVBOR", "", "36px"]);
    expect([dee?.className, dee?.style.height]).toEqual(["avatar selected", "20px"]);
    expect([eve?.tagName, eve?.textContent]).toEqual(["SPAN", "E"]);
    expect([user?.className, user?.style.width, user?.style.height, user?.getAttribute("aria-hidden"), user?.querySelector("svg")?.getAttribute("width")]).toEqual(["avatar user", "36px", "36px", "true", "18"]);
    expect([small?.style.width, small?.querySelector("svg")?.getAttribute("width")]).toEqual(["20px", "10"]);
  });
});

describe("toasts", () => {
  async function fresh(tag: string) { return await import(`../../src/browser/ui/toast.tsx?${tag}`) as typeof import("../../src/browser/ui/toast.tsx"); }

  test("show the newest four, once per text, each dismissed after a while, errors later", async () => {
    jest.useFakeTimers();
    const { toasts } = await fresh("store");
    let heard = 0;
    const leave = toasts.subscribe(() => { heard += 1; });
    toasts.show("one");
    toasts.show("oops", "error");
    expect(toasts.getSnapshot()).toEqual([{ id: 1, text: "one", tone: "info" }, { id: 2, text: "oops", tone: "error" }]);
    toasts.show("one");
    expect(toasts.getSnapshot().map((item) => [item.id, item.text])).toEqual([[2, "oops"], [3, "one"]]);
    for (const text of ["a", "b", "c"]) toasts.show(text);
    expect(toasts.getSnapshot().map((item) => item.text)).toEqual(["one", "a", "b", "c"]);
    expect(heard).toBe(6);
    jest.advanceTimersByTime(3499);
    expect(toasts.getSnapshot()).toHaveLength(4);
    jest.advanceTimersByTime(1);
    expect(toasts.getSnapshot()).toHaveLength(0);
    toasts.show("late", "error");
    jest.advanceTimersByTime(7999);
    expect(toasts.getSnapshot()).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(toasts.getSnapshot()).toHaveLength(0);
    const count = heard;
    toasts.dismiss(999);
    expect(heard, "dismissing nothing tells no one").toBe(count);
    leave();
    toasts.show("unheard");
    expect(heard).toBe(count);
  });

  test("are listed for readers, errors as alerts, each with a button to dismiss it", async () => {
    const { Toasts, toasts } = await fresh("view");
    const view = await mount(<Toasts />);
    const region = view.host.querySelector(".toasts");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    await acting(() => { toasts.show("saved"); toasts.show("broke", "error"); });
    const items = [...view.host.querySelectorAll(".toast")];
    expect(items.map((item) => [item.className, item.getAttribute("role"), item.textContent, item.querySelector("svg")?.getAttribute("width")])).toEqual([
      ["toast info", "status", "saved", "16"], ["toast error", "alert", "broke", "16"],
    ]);
    expect(items.map((item) => item.querySelector("svg path")?.getAttribute("d"))).toEqual(["M5 12l5 5 9-10", "M12 4l9 16H3z"]);
    const dismiss = button(items[1] ?? view.host, "Dismiss");
    expect([dismiss.className, dismiss.querySelector("svg")?.getAttribute("width")]).toEqual(["toast-close", "14"]);
    await click(dismiss);
    expect([...view.host.querySelectorAll(".toast")].map((item) => item.textContent)).toEqual(["saved"]);
  });
});

describe("a QR code", () => {
  test("draws each dark module inside a quiet border, and names what it holds", async () => {
    const { QrCode } = await import("../../src/browser/ui/qr.tsx");
    const view = await mount(<QrCode text="https://shore.test/#login=abc" label="Sign-in code" />);
    const svg = view.host.querySelector("svg");
    const viewBox = svg?.getAttribute("viewBox") ?? "";
    const size = Number(viewBox.split(" ")[2]);
    expect([svg?.getAttribute("role"), svg?.getAttribute("aria-label"), svg?.getAttribute("class"), viewBox]).toEqual(["img", "Sign-in code", "qr-code", `0 0 ${String(size)} ${String(size)}`]);
    expect((size - 8 - 17) % 4, "a QR symbol is 17 + 4n modules wide, plus a four-module border on each side").toBe(0);
    expect([view.host.querySelector("rect")?.getAttribute("width"), view.host.querySelector("rect")?.getAttribute("class")]).toEqual([String(size), "qr-light"]);
    const path = view.host.querySelector("path.qr-dark")?.getAttribute("d") ?? "";
    expect(path.startsWith("M4 4h1v1h-1z"), "the finder pattern's corner sits just inside the border").toBe(true);
    expect(path.includes("M0 0h1v1h-1z") || path.includes("M3 3h1v1h-1z"), "the border stays light").toBe(false);
    expect(path.match(/M/g)?.length ?? 0).toBeGreaterThan(100);
  });
});
