import { isValidThreadId } from "../engine/threads.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import type { Texts } from "../texts/texts.ts";

export interface SendMessageRequest {
  text: string;
  thread?: string;
  push: boolean;
}

export type SendMessage = (request: SendMessageRequest) => Promise<string>;

export function sendMessageRequest(texts: Texts, input: Record<string, unknown>): SendMessageRequest {
  const text = typeof input["text"] === "string" ? input["text"].trim() : "";
  if (text === "") throw new InvalidArgs(texts.always("send_no_text"));
  const push = input["push"] === true;
  const named = input["thread"];
  if (named === undefined) return { text, push };
  const thread = typeof named === "string" ? named.trim() : "";
  if (!isValidThreadId(thread)) throw new InvalidArgs(texts.always("arg_thread_id"));
  return { text, thread, push };
}

export async function handleSendMessage(texts: Texts, input: Record<string, unknown>, send: SendMessage | undefined): Promise<string> {
  if (send === undefined) throw new ToolIoError(texts.always("send_unavailable"));
  return await send(sendMessageRequest(texts, input));
}
