import { shoreLog } from "../../log.ts";
import { jsonSidecar, type Sidecar } from "./store.ts";

const VIEW_KEYS = ["thinking", "tools", "usage"] as const;

type ViewKey = (typeof VIEW_KEYS)[number];

export type RoomView = Record<ViewKey, boolean>;

const defaultRoomView = (): RoomView => ({ thinking: false, tools: false, usage: false });

function isViewKey(key: string): key is ViewKey {
  return (VIEW_KEYS as readonly string[]).includes(key);
}

export class ViewPrefs {
  readonly #rooms = new Map<string, RoomView>();
  readonly #sidecar: Sidecar<Record<string, Partial<RoomView>>>;

  constructor(path?: string) {
    this.#sidecar = jsonSidecar<Record<string, Partial<RoomView>>>(path, () => ({}));
    for (const [roomId, stored] of Object.entries(this.#sidecar.read())) {
      if (typeof stored !== "object" || stored === null) continue;
      const view = defaultRoomView();
      for (const key of VIEW_KEYS) {
        if (typeof stored[key] === "boolean") view[key] = stored[key];
      }
      this.#rooms.set(roomId, view);
    }
  }

  room(roomId: string): RoomView {
    return { ...(this.#rooms.get(roomId) ?? defaultRoomView()) };
  }

  set(roomId: string, key: string, value: boolean | undefined): boolean | undefined {
    if (!isViewKey(key)) return undefined;
    const view = this.room(roomId);
    view[key] = value ?? !view[key];
    this.#rooms.set(roomId, view);
    try {
      this.#sidecar.write(Object.fromEntries(this.#rooms));
    } catch (e) {
      shoreLog.warn(`shore: could not persist Matrix view preferences: ${String(e)}`);
    }
    return view[key];
  }
}
