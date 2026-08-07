import type { Cancel } from "./Cancel";
import type { ClientHello } from "./ClientHello";
import type { ClientMessageBody } from "./ClientMessageBody";
import type { Command } from "./Command";
import type { Regen } from "./Regen";

export type ClientMessage = { "type": "hello" } & ClientHello | { "type": "message" } & ClientMessageBody | { "type": "regen" } & Regen | { "type": "command" } & Command | { "type": "cancel" } & Cancel;
