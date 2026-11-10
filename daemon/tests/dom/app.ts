import { afterAll, afterEach, beforeAll } from "bun:test";

import { catalogue, connect, type Answer, type FakeSocket } from "./daemon.ts";

export { HOLD } from "./daemon.ts";
import { useDom } from "./dom.ts";

type State = typeof import("../../src/browser/app/state.ts");

export function useApp(url = "http://shore.test:7340/workspace/ada/story") {
  useDom(url);
  const lasting: (() => void)[] = [];
  const restores: (() => void)[] = [];
  let socket: FakeSocket | undefined;
  let state: State | undefined;
  let answer: Answer = catalogue;
  beforeAll(async () => {
    Object.assign(globalThis, { SHORE_WEB_CONTRACT: "c1", SHORE_WEB_PROTOCOL: 2 });
    state = await import("../../src/browser/app/state.ts");
    socket = await connect(state.workspace.connection, lasting, (request) => answer(request));
  });
  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    answer = catalogue;
    document.body.replaceChildren();
  });
  afterAll(() => {
    state?.workspace.connection.stop();
    for (const restore of lasting.splice(0).reverse()) restore();
    for (const key of ["SHORE_WEB_CONTRACT", "SHORE_WEB_PROTOCOL"]) Reflect.deleteProperty(globalThis, key);
  });
  return {
    state: (): State => { if (state === undefined) throw new Error("the app is not loaded"); return state; },
    socket: (): FakeSocket => { if (socket === undefined) throw new Error("the app is not connected"); return socket; },
    answer: (next: Answer) => { answer = (request) => next(request) ?? catalogue(request); },
    restores,
    sent: (since: number) => (socket?.sent ?? []).slice(since),
  };
}
