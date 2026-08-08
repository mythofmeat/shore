import { jsonSidecar, type Sidecar } from "./store.ts";

export type EventOrigin = "assistant" | "mirrored_user" | "matrix_user";

const BOT_EDITABLE: ReadonlySet<EventOrigin> = new Set<EventOrigin>([
  "assistant",
  "mirrored_user",
]);

export interface MappedEvent {
  msgId: string;
  roomId: string;
  eventId: string;
  origin: EventOrigin;
  content: string;
}

interface PersistedEvents {
  entries: MappedEvent[];
}

export const EVENT_MAP_CAP = 2000;

export class EventMap {
  #entries: MappedEvent[] = [];
  readonly #sidecar: Sidecar<PersistedEvents>;

  constructor(path?: string) {
    this.#sidecar = jsonSidecar<PersistedEvents>(path, () => ({ entries: [] }));
    const loaded = this.#sidecar.read().entries;
    if (Array.isArray(loaded)) this.#entries = loaded.filter(isMappedEvent);
  }

  record(entry: MappedEvent): void {
    this.#entries = this.#entries.filter(
      (e) => e.msgId !== entry.msgId && e.eventId !== entry.eventId,
    );
    this.#entries.push(entry);
    if (this.#entries.length > EVENT_MAP_CAP) {
      this.#entries = this.#entries.slice(this.#entries.length - EVENT_MAP_CAP);
    }
    this.#save();
  }

  byMsgId(msgId: string): MappedEvent | undefined {
    return findLast(this.#entries, (e) => e.msgId === msgId);
  }

  byEventId(eventId: string): MappedEvent | undefined {
    return findLast(this.#entries, (e) => e.eventId === eventId);
  }

  latestReplyInRoom(roomId: string): MappedEvent | undefined {
    return findLast(this.#entries, (e) => e.roomId === roomId && e.origin === "assistant");
  }

  updateContent(msgId: string, content: string): void {
    const entry = findLast(this.#entries, (e) => e.msgId === msgId);
    if (entry === undefined) return;
    entry.content = content;
    this.#save();
  }

  removeMsg(msgId: string): MappedEvent | undefined {
    return this.#removeWhere((e) => e.msgId === msgId);
  }

  removeEvent(eventId: string): MappedEvent | undefined {
    return this.#removeWhere((e) => e.eventId === eventId);
  }

  pruneMissing(roomId: string, liveIds: ReadonlySet<string>): void {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter(
      (e) => e.roomId !== roomId || liveIds.has(e.msgId),
    );
    if (this.#entries.length !== before) this.#save();
  }

  #removeWhere(match: (e: MappedEvent) => boolean): MappedEvent | undefined {
    const at = this.#entries.findIndex(match);
    if (at === -1) return undefined;
    const [removed] = this.#entries.splice(at, 1);
    this.#save();
    return removed;
  }

  #save(): void {
    this.#sidecar.write({ entries: this.#entries });
  }
}

function findLast<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i] as T;
    if (match(item)) return item;
  }
  return undefined;
}

function isMappedEvent(value: unknown): value is MappedEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.msgId === "string" &&
    typeof e.roomId === "string" &&
    typeof e.eventId === "string" &&
    typeof e.content === "string" &&
    (e.origin === "assistant" || e.origin === "mirrored_user" || e.origin === "matrix_user")
  );
}
