import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { StrictMode, type ReactElement } from "react";

import { acting, mount, useDom } from "./dom.ts";

useDom();

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  document.body.replaceChildren();
});

async function controls() { return await import("../../src/browser/ui/controls.tsx"); }

function key(target: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

const buttons = (root: ParentNode) => [...root.querySelectorAll("button")];
const labelled = (root: ParentNode, label: string) => {
  const found = [...root.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === label || button.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};

describe("an icon button", () => {
  test("is a plain button named by its label, with its icon at the size asked for", async () => {
    const { IconButton } = await controls();
    let pressed = 0;
    const view = await mount(<IconButton icon="close" label="Close" className="extra" onClick={() => { pressed += 1; }} />);
    const button = view.host.querySelector("button");
    expect([button?.type, button?.className, button?.getAttribute("aria-label"), button?.title]).toEqual(["button", "icon-button extra", "Close", "Close"]);
    expect(button?.querySelector("svg")?.getAttribute("width")).toBe("18");
    await acting(() => { button?.click(); });
    expect(pressed).toBe(1);
    await view.update(<IconButton icon="close" label="Close" size={12} disabled />);
    expect([view.host.querySelector("svg")?.getAttribute("width"), view.host.querySelector("button")?.disabled, view.host.querySelector("button")?.className]).toEqual(["12", true, "icon-button "]);
  });
});

describe("a menu", () => {
  test("opens from its button on the first enabled item, and closes with a choice, outside, or Escape back on its button", async () => {
    const { Menu } = await controls();
    const chosen: string[] = [];
    const view = await mount(<div>
      <Menu label="Thread actions" items={[
        { label: "Disabled", onSelect: () => { chosen.push("disabled"); }, disabled: true },
        { label: "Rename", icon: "edit", detail: "R", onSelect: () => { chosen.push("rename"); } },
        "separator",
        { label: "Delete", danger: true, onSelect: () => { chosen.push("delete"); } },
      ]} />
      <p id="elsewhere">elsewhere</p>
    </div>);
    const trigger = view.host.querySelector("button");
    expect([trigger?.getAttribute("aria-label"), trigger?.title, trigger?.getAttribute("aria-haspopup"), trigger?.getAttribute("aria-expanded"), trigger?.hasAttribute("aria-controls"), trigger?.className]).toEqual(["Thread actions", "Thread actions", "menu", "false", false, "icon-button"]);
    expect(view.host.querySelector("[role=menu]")).toBeNull();
    await acting(() => { trigger?.click(); });
    const list = view.host.querySelector("[role=menu]");
    expect([list?.getAttribute("aria-label"), list?.className, list?.id === trigger?.getAttribute("aria-controls"), trigger?.getAttribute("aria-expanded")]).toEqual(["Thread actions", "menu-list align-end below", true, "true"]);
    expect(document.activeElement?.textContent).toBe("RenameR");
    expect(view.host.querySelector("[role=separator]")?.className).toBe("menu-separator");
    const items = [...(list?.querySelectorAll("[role=menuitem]") ?? [])] as HTMLButtonElement[];
    expect(items.map((item) => [item.textContent, item.className, item.disabled, item.querySelector("svg") !== null, item.querySelector(".menu-detail")?.textContent ?? null])).toEqual([
      ["Disabled", "", true, false, null], ["RenameR", "", false, true, "R"], ["Delete", "danger", false, false, null],
    ]);
    await acting(() => { items[1]?.click(); });
    expect(chosen).toEqual(["rename"]);
    expect(view.host.querySelector("[role=menu]")).toBeNull();

    await acting(() => { trigger?.click(); });
    await acting(() => { view.host.querySelector("[role=menu]")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(view.host.querySelector("[role=menu]"), "a press inside keeps it open").not.toBeNull();
    await acting(() => { document.getElementById("elsewhere")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(view.host.querySelector("[role=menu]")).toBeNull();

    await acting(() => { trigger?.click(); });
    let outer = 0;
    const count = () => { outer += 1; };
    document.addEventListener("keydown", count);
    restores.push(() => { document.removeEventListener("keydown", count); });
    let escape: KeyboardEvent | undefined;
    await acting(() => { escape = key(document.activeElement ?? view.host, "Escape"); });
    expect(view.host.querySelector("[role=menu]")).toBeNull();
    expect([escape?.defaultPrevented, outer, document.activeElement === trigger]).toEqual([true, 0, true]);
    await acting(() => { trigger?.click(); });
    await acting(() => { trigger?.click(); });
    expect(view.host.querySelector("[role=menu]"), "its button toggles it").toBeNull();
    const ignored = key(trigger ?? view.host, "ArrowDown");
    expect(ignored.defaultPrevented, "keys do nothing while closed").toBe(false);
  });

  test("moves between enabled items with the arrow keys, round the ends", async () => {
    const { Menu } = await controls();
    const item = (label: string, disabled = false) => ({ label, disabled, onSelect: () => {} });
    const view = await mount(<Menu label="Pick" defaultOpen items={[item("one"), item("off", true), item("two"), item("three")]} />);
    const focused = () => document.activeElement?.textContent;
    expect(focused()).toBe("one");
    for (const [direction, expected] of [["ArrowDown", "two"], ["ArrowDown", "three"], ["ArrowDown", "one"], ["ArrowUp", "three"], ["ArrowUp", "two"]] as const) {
      let event: KeyboardEvent | undefined;
      await acting(() => { event = key(document.activeElement ?? view.host, direction); });
      expect([focused(), event?.defaultPrevented]).toEqual([expected, true]);
    }
    let other: KeyboardEvent | undefined;
    await acting(() => { other = key(document.activeElement ?? view.host, "Enter"); });
    expect(other?.defaultPrevented).toBe(false);
  });

  test("takes its own trigger, placement and icon, and can be opened by an event while mounted", async () => {
    const { Menu } = await controls();
    const view = await mount(<Menu label="Model" items={[{ label: "Opus", onSelect: () => {} }]} trigger={<span>Opus</span>} triggerClassName="chip" align="start" placement="above" openEvent="shore:test-open" />);
    const trigger = view.host.querySelector("button");
    expect([trigger?.className, trigger?.hasAttribute("aria-label"), trigger?.hasAttribute("title"), trigger?.textContent]).toEqual(["chip", false, false, "Opus"]);
    await acting(() => { dispatchEvent(new Event("shore:test-open")); });
    expect(view.host.querySelector("[role=menu]")?.className).toBe("menu-list align-start above");
    await view.update(<Menu label="Model" items={[]} triggerLabel="Choose" icon="plus" />);
    expect([trigger?.getAttribute("aria-label"), trigger?.title]).toEqual(["Choose", "Choose"]);
    await view.unmount();
    expect(() => { dispatchEvent(new Event("shore:test-open")); }).not.toThrow();
  });

  test("an open event stops opening it once it is gone", async () => {
    const { Menu } = await controls();
    const adds = spyOn(window, "removeEventListener");
    restores.push(() => { adds.mockRestore(); });
    const view = await mount(<Menu label="Model" items={[]} openEvent="shore:other-open" />);
    await view.unmount();
    expect(adds.mock.calls.some(([type]) => type === "shore:other-open")).toBe(true);
  });
});

describe("a menu at a point", () => {
  test("opens inside the window at the point, focused on its first enabled item, and closes on a choice", async () => {
    const { PointMenu } = await controls();
    const boxes = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 50, top: 0, left: 0, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    restores.push(() => { boxes.mockRestore(); });
    const closed: string[] = [];
    const chosen: string[] = [];
    const items = [{ label: "Off", disabled: true, onSelect: () => {} }, { label: "Copy", icon: "copy" as const, detail: "C", onSelect: () => { chosen.push("copy"); } }, "separator" as const, { label: "Delete", danger: true, onSelect: () => {} }];
    const view = await mount(<PointMenu label="Message" items={items} at={{ x: 2000, y: 3 }} close={() => { closed.push("closed"); }} />);
    const list = document.body.querySelector<HTMLElement>(".menu-list.point");
    expect(list?.parentElement).toBe(document.body);
    expect([list?.style.left, list?.style.top, list?.getAttribute("aria-label")]).toEqual([`${String(innerWidth - 108)}px`, "8px", "Message"]);
    expect(document.activeElement?.textContent).toBe("CopyC");
    expect([...(list?.querySelectorAll("[role=menuitem]") ?? [])].map((item) => item.className)).toEqual(["", "", "danger"]);
    await view.update(<PointMenu label="Message" items={items} at={{ x: 40, y: 2000 }} close={() => { closed.push("closed"); }} />);
    expect([list?.style.left, list?.style.top]).toEqual(["40px", `${String(innerHeight - 58)}px`]);
    await acting(() => { labelled(list ?? document.body, "CopyC").click(); });
    expect([chosen, closed]).toEqual([["copy"], ["closed"]]);
  });

  test("closes on a press outside, the window losing focus or resizing, Escape or Tab, and puts the focus back", async () => {
    const { PointMenu } = await controls();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    let closes = 0;
    const items = ["Copy", "Off", "Quote", "Edit"].map((label) => ({ label, disabled: label === "Off", onSelect: () => {} }));
    const view = await mount(<PointMenu label="Message" items={items} at={{ x: 10, y: 10 }} close={() => { closes += 1; }} />);
    const list = document.body.querySelector<HTMLElement>(".menu-list.point");
    if (list === null) throw new Error("no menu");
    await acting(() => { list.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(closes).toBe(0);
    await acting(() => { opener.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await acting(() => { dispatchEvent(new Event("blur")); });
    await acting(() => { dispatchEvent(new Event("resize")); });
    expect(closes).toBe(3);
    let outer = 0;
    const count = () => { outer += 1; };
    document.addEventListener("keydown", count);
    restores.push(() => { document.removeEventListener("keydown", count); });
    for (const name of ["Escape", "Tab"]) {
      let event: KeyboardEvent | undefined;
      await acting(() => { event = key(document.activeElement ?? list, name); });
      expect(event?.defaultPrevented, name).toBe(true);
    }
    expect([closes, outer]).toEqual([5, 0]);
    for (const [direction, expected] of [["ArrowDown", "Quote"], ["ArrowDown", "Edit"], ["ArrowDown", "Copy"], ["ArrowUp", "Edit"], ["ArrowUp", "Quote"]] as const) {
      await acting(() => { key(document.activeElement ?? list, direction); });
      expect(document.activeElement?.textContent).toBe(expected);
    }
    const plain = key(document.activeElement ?? list, "a");
    expect(plain.defaultPrevented).toBe(false);
    const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    list.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(true);
    await view.unmount();
    expect(document.activeElement).toBe(opener);
    await acting(() => { dispatchEvent(new Event("resize")); document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); dispatchEvent(new Event("blur")); });
    expect(closes, "nothing is listening once it is gone").toBe(5);
  });

  test("leaves the focus alone when what opened it is gone", async () => {
    const { PointMenu } = await controls();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = await mount(<PointMenu label="Message" items={[{ label: "Copy", onSelect: () => {} }]} at={{ x: 10, y: 10 }} close={() => {}} />);
    opener.remove();
    const focus = spyOn(opener, "focus");
    await view.unmount();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe("waiting for dialogs to close", () => {
  test("runs at once with no dialog open, otherwise once the last one closes, unless cancelled", async () => {
    const { whenNoDialogOpen, Dialog } = await controls();
    let ran = 0;
    whenNoDialogOpen(() => { ran += 1; });
    expect(ran).toBe(1);
    dispatchEvent(new Event("shore:dialog-closed"));
    expect(ran, "it does not run again").toBe(1);
    const view = await mount(<Dialog title="One" close={() => {}}><p>body</p></Dialog>);
    whenNoDialogOpen(() => { ran += 1; });
    const cancel = whenNoDialogOpen(() => { ran += 100; });
    expect(ran).toBe(1);
    dispatchEvent(new Event("shore:dialog-closed"));
    expect(ran, "a dialog is still open").toBe(1);
    cancel();
    await view.unmount();
    expect(ran).toBe(2);
  });
});

describe("a dialog", () => {
  test("opens modal, focused on what asks for it, titled and described, and closes from its button", async () => {
    const { Dialog } = await controls();
    let closes = 0;
    const view = await mount(<Dialog title="Rename" close={() => { closes += 1; }} describedBy="help" wide footer={<span>footer</span>}>
      <input data-autofocus />
      <button type="submit">Save</button>
    </Dialog>);
    const dialog = view.host.querySelector("dialog");
    expect([dialog?.open, dialog?.className, dialog?.getAttribute("aria-describedby"), dialog?.tabIndex]).toEqual([true, "dialog wide", "help", -1]);
    expect(document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Rename");
    expect(document.activeElement?.tagName).toBe("INPUT");
    expect(view.host.querySelector(".dialog-footer")?.textContent).toBe("footer");
    await acting(() => { labelled(view.host, "Close").click(); });
    expect(closes).toBe(1);
  });

  test("focuses an enabled submit button, then a primary action, then itself", async () => {
    const { Dialog } = await controls();
    const cases: [ReactElement, string][] = [
      [<><button type="submit" disabled>Off</button><button type="submit">Go</button></>, "Go"],
      [<div className="form-actions"><button className="button primary" disabled>Off</button><button className="button primary">Do</button></div>, "Do"],
      [<p>nothing to press</p>, "DIALOG"],
    ];
    for (const [children, expected] of cases) {
      const view = await mount(<Dialog title="T" close={() => {}}>{children}</Dialog>);
      expect(document.activeElement?.tagName === "DIALOG" ? "DIALOG" : document.activeElement?.textContent).toBe(expected);
      expect(view.host.querySelector(".dialog-footer")).toBeNull();
      expect(view.host.querySelector("dialog")?.className).toBe("dialog ");
      await view.unmount();
    }
  });

  test("closes on cancel, on its backdrop and on Escape in a search box, but not on clicks or keys inside", async () => {
    const { Dialog } = await controls();
    let closes = 0;
    const view = await mount(<Dialog title="Find" close={() => { closes += 1; }}><input type="search" /><input type="text" /><p>inside</p></Dialog>);
    const dialog = view.host.querySelector("dialog");
    if (dialog === null) throw new Error("no dialog");
    const cancel = new Event("cancel", { cancelable: true });
    await acting(() => { dialog.dispatchEvent(cancel); });
    expect([closes, cancel.defaultPrevented]).toEqual([1, true]);
    await acting(() => { dialog.click(); });
    await acting(() => { dialog.querySelector("p")?.click(); });
    expect(closes).toBe(2);
    const [search, text] = [...dialog.querySelectorAll("input")];
    let inSearch: KeyboardEvent | undefined;
    await acting(() => { if (search !== undefined) inSearch = key(search, "Escape"); });
    expect([closes, inSearch?.defaultPrevented]).toEqual([3, true]);
    await acting(() => { if (text !== undefined) key(text, "Escape"); if (search !== undefined) key(search, "Enter"); });
    expect(closes).toBe(3);
  });

  test("opens once even when React runs its effects twice", async () => {
    const { Dialog } = await controls();
    const opens = spyOn(HTMLDialogElement.prototype, "showModal");
    restores.push(() => { opens.mockRestore(); });
    const view = await mount(<StrictMode><Dialog title="T" close={() => {}}><p /></Dialog></StrictMode>);
    expect(opens).toHaveBeenCalledTimes(1);
    expect(view.host.querySelector("dialog")?.open).toBe(true);
    await view.unmount();
  });
});

describe("small controls", () => {
  test("a switch shows and flips its state unless disabled, and a spinner says it is loading", async () => {
    const { Spinner, Switch } = await controls();
    const changes: boolean[] = [];
    const view = await mount(<Switch checked label="Stream" change={(value) => { changes.push(value); }} />);
    const button = view.host.querySelector("button");
    expect([button?.getAttribute("role"), button?.getAttribute("aria-checked"), button?.getAttribute("aria-label"), button?.disabled, button?.type]).toEqual(["switch", "true", "Stream", false, "button"]);
    await acting(() => { button?.click(); });
    await view.update(<Switch checked={false} label="Stream" disabled change={(value) => { changes.push(value); }} />);
    expect([button?.getAttribute("aria-checked"), button?.disabled]).toEqual(["false", true]);
    expect(changes).toEqual([false]);
    await view.update(<><Spinner /><Spinner label="Saving" /></>);
    expect([...view.host.querySelectorAll("[role=status]")].map((spinner) => [spinner.className, spinner.getAttribute("aria-label")])).toEqual([["spinner", "Loading"], ["spinner", "Saving"]]);
    expect(buttons(view.host)).toHaveLength(0);
  });
});
