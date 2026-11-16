import { isValidThreadId } from "../engine/threads.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";

export interface SendMessageRequest {
  text: string;
  thread?: string;
  push: boolean;
}

export type SendMessage = (request: SendMessageRequest) => Promise<string>;

export function sendMessageRequest(input: Record<string, unknown>): SendMessageRequest {
  const text = typeof input["text"] === "string" ? input["text"].trim() : "";
  if (text === "") throw new InvalidArgs("text must be a non-empty string");
  const push = input["push"] === true;
  const named = input["thread"];
  if (named === undefined) return { text, push };
  const thread = typeof named === "string" ? named.trim() : "";
  if (!isValidThreadId(thread)) throw new InvalidArgs("thread must be a thread's id, as `threads` lists it");
  return { text, thread, push };
}

export async function handleSendMessage(input: Record<string, unknown>, send: SendMessage | undefined): Promise<string> {
  if (send === undefined) throw new ToolIoError("messages can't be sent from here");
  return await send(sendMessageRequest(input));
}
