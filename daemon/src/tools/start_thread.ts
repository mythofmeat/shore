import { InvalidArgs, ToolIoError } from "./errors.ts";
import { cleanFolderName } from "../engine/thread_layout.ts";
import { isValidThreadId, MAX_THREAD_ID_LENGTH, ThreadError, threadErrorText } from "../engine/threads.ts";
import type { Texts } from "../texts/texts.ts";

export interface StartThreadRequest {
  name: string;
  label: string;
  purpose?: string;
  pins?: string[];
  opening?: string;
  folder?: string;
}

function text(texts: Texts, input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field] as string | null | undefined;
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function startThreadRequest(texts: Texts, input: Record<string, unknown>): StartThreadRequest {
  const name = text(texts, input, "name");
  if (name === undefined || !isValidThreadId(name)) throw new InvalidArgs(texts.always("threads_name_form", { max: String(MAX_THREAD_ID_LENGTH) }));
  const label = text(texts, input, "label");
  if (label === undefined) throw new InvalidArgs(texts.always("threads_label_required"));
  const pins = input["pins"];
  if (pins !== undefined && (!Array.isArray(pins) || !pins.every((pin) => typeof pin === "string"))) throw new InvalidArgs(texts.always("threads_pins_form"));
  const purpose = text(texts, input, "purpose");
  const opening = text(texts, input, "opening");
  const named = text(texts, input, "folder");
  const folder = named === undefined ? undefined : cleanFolderName(named);
  const given = pins?.map((pin) => pin.trim()).filter((pin) => pin !== "") ?? [];
  return {
    name,
    label,
    ...(purpose === undefined ? {} : { purpose }),
    ...(given.length === 0 ? {} : { pins: given }),
    ...(opening === undefined ? {} : { opening }),
    ...(folder === undefined ? {} : { folder }),
  };
}

export function startRefusal(texts: Texts, e: ThreadError, name: unknown, userName: string): ToolIoError {
  if (e.kind === "archived") return new ToolIoError(texts.always("threads_name_archived", { user: userName, name: JSON.stringify(name) }));
  if (e.kind !== "on_hold") return new ToolIoError(threadErrorText(texts, e));
  return new ToolIoError(texts.always("threads_name_on_hold", { user: userName, name: JSON.stringify(name) }));
}

export async function handleStartThread(
  texts: Texts,
  input: Record<string, unknown>,
  start: ((request: StartThreadRequest) => Promise<void>) | undefined,
  userName: string,
): Promise<string> {
  if (start === undefined) throw new ToolIoError(texts.always("threads_start_unavailable"));
  let request: StartThreadRequest;
  try {
    request = startThreadRequest(texts, input);
    await start(request);
  } catch (e) {
    if (e instanceof ThreadError) throw startRefusal(texts, e, input["name"], userName);
    throw e;
  }
  return texts.render("threads_started", { name: request.name, label: request.label, opening: request.opening === undefined ? undefined : "yes", folder: request.folder, user: userName }) ?? "";
}
