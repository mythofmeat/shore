import { jsonSidecar, type Sidecar } from "./store.ts";

interface PersistedBindings {
  bindings: [character: string, roomId: string][];
}

export class RoomBindings {
  readonly #roomToCharacter = new Map<string, string>();
  readonly #characterToRoom = new Map<string, string>();
  readonly #sidecar: Sidecar<PersistedBindings>;

  constructor(path?: string) {
    this.#sidecar = jsonSidecar<PersistedBindings>(path, () => ({ bindings: [] }));
    for (const entry of this.#sidecar.read().bindings) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
        this.#apply(entry[1], entry[0]);
      }
    }
  }

  bind(roomId: string, character: string): void {
    this.#apply(roomId, character);
    this.#save();
  }

  unbindRoom(roomId: string): void {
    const character = this.#roomToCharacter.get(roomId);
    if (character === undefined) return;
    this.#roomToCharacter.delete(roomId);
    this.#characterToRoom.delete(character);
    this.#save();
  }

  characterForRoom(roomId: string): string | undefined {
    return this.#roomToCharacter.get(roomId);
  }

  roomForCharacter(character: string): string | undefined {
    return this.#characterToRoom.get(character);
  }

  isBound(roomId: string): boolean {
    return this.#roomToCharacter.has(roomId);
  }

  entries(): [character: string, roomId: string][] {
    return [...this.#characterToRoom.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  #apply(roomId: string, character: string): void {
    const previousRoom = this.#characterToRoom.get(character);
    if (previousRoom !== undefined) this.#roomToCharacter.delete(previousRoom);
    const previousCharacter = this.#roomToCharacter.get(roomId);
    if (previousCharacter !== undefined) this.#characterToRoom.delete(previousCharacter);
    this.#roomToCharacter.set(roomId, character);
    this.#characterToRoom.set(character, roomId);
  }

  #save(): void {
    this.#sidecar.write({ bindings: this.entries() });
  }
}
