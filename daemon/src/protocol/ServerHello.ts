import type { CharacterInfo } from "./CharacterInfo";

export type ServerHello = { v: number, server_name: string, characters: Array<CharacterInfo>, };
