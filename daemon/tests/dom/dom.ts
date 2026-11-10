import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ReactElement } from "react";

export function useDom(url = "http://shore.test:7340/"): void {
  beforeAll(() => {
    GlobalRegistrator.register({ url });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  afterAll(async () => {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    await GlobalRegistrator.unregister();
  });
}

export async function acting(work: () => unknown): Promise<void> {
  await act(async () => { await work(); });
}

export async function mount(element: ReactElement) {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await acting(() => { root.render(element); });
  return {
    host,
    update: async (next: ReactElement) => { await acting(() => { root.render(next); }); },
    unmount: async () => { await acting(() => { root.unmount(); }); host.remove(); },
  };
}

export async function renderHook<T, P>(hook: (props: P) => T, initial: P) {
  const seen: T[] = [];
  function Probe(props: { value: P }): null {
    seen.push(hook(props.value));
    return null;
  }
  const view = await mount(createElement(Probe, { value: initial }));
  return {
    ...view,
    current: (): T => {
      const latest = seen.at(-1);
      if (latest === undefined) throw new Error("the hook never rendered");
      return latest;
    },
    renders: () => seen.length,
    rerender: async (props: P) => { await view.update(createElement(Probe, { value: props })); },
  };
}

export function blockStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("storage is blocked"); } });
  return () => { if (original === undefined) Reflect.deleteProperty(globalThis, "localStorage"); else Object.defineProperty(globalThis, "localStorage", original); };
}

export async function type(element: Element | null | undefined, value: string): Promise<void> {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error("nothing to type into");
  await acting(() => {
    Reflect.set(Object.getPrototypeOf(element) as object, "value", value, element);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error("nothing to click");
  await acting(() => { element.click(); });
}

export function button(root: ParentNode, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name || item.textContent === name);
  if (found === undefined) throw new Error(`no button named ${name}`);
  return found;
}
