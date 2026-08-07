import type { Message } from "./Message";

export type History = { rid?: string | null, messages: Array<Message>, 
active_start?: number, config: unknown, selected_character?: string | null, revision: number, };
