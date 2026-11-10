import { afterEach, describe, expect, jest, test } from "bun:test";
import type { MouseEvent, PointerEvent } from "react";

import { acting, renderHook, useDom } from "./dom.ts";

useDom();

afterEach(() => { jest.useRealTimers(); });

const row = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) };
let prevented = 0;
const mouse = (x: number, y: number) => ({ clientX: x, clientY: y, currentTarget: row, preventDefault: () => { prevented += 1; } }) as unknown as MouseEvent<HTMLElement>;
const pointer = (type: string, x: number, y: number) => ({ pointerType: type, clientX: x, clientY: y }) as unknown as PointerEvent<HTMLElement>;

async function menu() {
  const { useRowMenu } = await import("../../src/browser/sidebar/row_menu.ts");
  return await renderHook(() => useRowMenu(), undefined);
}

describe("a thread row's menu", () => {
  test("opens where it was asked for, below the row when asked from the keyboard, and closes", async () => {
    const hook = await menu();
    expect(hook.current().at).toBeNull();
    prevented = 0;
    await acting(() => { hook.current().handlers.onContextMenu(mouse(100, 200)); });
    expect(hook.current().at).toEqual({ x: 100, y: 200 });
    expect(prevented).toBe(1);
    await acting(() => { hook.current().handlers.onContextMenu(mouse(0, 0)); });
    expect(hook.current().at).toEqual({ x: 34, y: 40 });
    await acting(() => { hook.current().handlers.onContextMenu(mouse(0, 50)); });
    expect(hook.current().at).toEqual({ x: 0, y: 50 });
    await acting(() => { hook.current().handlers.onContextMenu(mouse(50, 0)); });
    expect(hook.current().at).toEqual({ x: 50, y: 0 });
    await acting(() => { hook.current().close(); });
    expect(hook.current().at).toBeNull();
    await acting(() => { hook.current().openFrom(mouse(0, 0)); });
    expect(hook.current().at).toEqual({ x: 10, y: 44 });
  });

  test("a long touch opens it where the finger is, and swallows the one click that follows", async () => {
    jest.useFakeTimers();
    const hook = await menu();
    expect(hook.current().swallowClick(), "nothing to swallow before any press").toBe(false);
    await acting(() => { hook.current().handlers.onPointerDown(pointer("touch", 5, 6)); });
    await acting(() => { jest.advanceTimersByTime(499); });
    expect(hook.current().at).toBeNull();
    await acting(() => { jest.advanceTimersByTime(1); });
    expect(hook.current().at).toEqual({ x: 5, y: 6 });
    expect(hook.current().swallowClick()).toBe(true);
    expect(hook.current().swallowClick()).toBe(false);
  });

  test("a mouse press, a moved finger, a lifted finger or a cancelled touch opens nothing", async () => {
    jest.useFakeTimers();
    const hook = await menu();
    const press = async (...steps: ((menu: ReturnType<typeof hook.current>) => void)[]) => {
      for (const step of steps) await acting(() => { step(hook.current()); });
      await acting(() => { jest.advanceTimersByTime(1000); });
      return hook.current().at;
    };
    expect(await press((m) => { m.handlers.onPointerDown(pointer("mouse", 5, 6)); })).toBeNull();
    expect(await press((m) => { m.handlers.onPointerDown(pointer("touch", 5, 6)); }, (m) => { m.handlers.onPointerMove(pointer("touch", 16, 6)); })).toBeNull();
    expect(await press((m) => { m.handlers.onPointerDown(pointer("touch", 5, 6)); }, (m) => { m.handlers.onPointerUp(); })).toBeNull();
    expect(await press((m) => { m.handlers.onPointerDown(pointer("touch", 5, 6)); }, (m) => { m.handlers.onPointerCancel(); })).toBeNull();
    expect(await press((m) => { m.handlers.onPointerMove(pointer("touch", 50, 50)); })).toBeNull();
    expect(hook.current().swallowClick()).toBe(false);
    expect(await press((m) => { m.handlers.onPointerDown(pointer("touch", 5, 6)); }, (m) => { m.handlers.onPointerMove(pointer("touch", 11, 14)); })).toEqual({ x: 5, y: 6 });
  });

  test("a right click during a touch, or a second touch, replaces the pending long press", async () => {
    jest.useFakeTimers();
    const hook = await menu();
    await acting(() => { hook.current().handlers.onPointerDown(pointer("touch", 5, 6)); });
    await acting(() => { hook.current().handlers.onContextMenu(mouse(100, 200)); });
    await acting(() => { jest.advanceTimersByTime(1000); });
    expect(hook.current().at).toEqual({ x: 100, y: 200 });
    expect(hook.current().swallowClick()).toBe(false);
    await acting(() => { hook.current().close(); });
    await acting(() => { hook.current().handlers.onPointerDown(pointer("touch", 1, 1)); });
    await acting(() => { jest.advanceTimersByTime(300); });
    await acting(() => { hook.current().handlers.onPointerDown(pointer("touch", 2, 2)); });
    await acting(() => { jest.advanceTimersByTime(300); });
    expect(hook.current().at, "the first press was replaced").toBeNull();
    await acting(() => { jest.advanceTimersByTime(200); });
    expect(hook.current().at).toEqual({ x: 2, y: 2 });
    await acting(() => { hook.current().handlers.onPointerDown(pointer("touch", 3, 3)); });
    expect(hook.current().swallowClick(), "a new touch forgets the long press before it").toBe(false);
  });
});
