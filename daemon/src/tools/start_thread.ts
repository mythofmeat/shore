import { InvalidArgs, ToolIoError } from "./errors.ts";
import { cleanFolderName } from "../engine/thread_layout.ts";
import { isValidThreadId, MAX_THREAD_ID_LENGTH, ThreadError } from "../engine/threads.ts";

export interface StartThreadRequest {
  name: string;
  label: string;
  purpose?: string;
  pins?: string[];
  opening?: string;
  folder?: string;
}

function text(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new InvalidArgs(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function startThreadRequest(input: Record<string, unknown>): StartThreadRequest {
  const name = text(input, "name");
  if (name === undefined || !isValidThreadId(name)) {
    throw new InvalidArgs(
      `name must be letters, digits, dot, dash or underscore, starting with a letter or digit, at most ${String(MAX_THREAD_ID_LENGTH)} characters`,
    );
  }
  const label = text(input, "label");
  if (label === undefined) throw new InvalidArgs("label is required");
  const pins = input["pins"];
  if (pins !== undefined && (!Array.isArray(pins) || !pins.every((pin) => typeof pin === "string"))) {
    throw new InvalidArgs("pins must be a list of workspace paths and !commands");
  }
  const purpose = text(input, "purpose");
  const opening = text(input, "opening");
  const named = text(input, "folder");
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

export function startRefusal(e: ThreadError, name: unknown, userName: string): ToolIoError {
  if (e.kind !== "on_hold") return new ToolIoError(e.message);
  return new ToolIoError(`Not started: ${userName} has a thread named ${JSON.stringify(name)} on hold, so that name is taken. Choose another.`);
}

export async function handleStartThread(
  input: Record<string, unknown>,
  start: ((request: StartThreadRequest) => Promise<void>) | undefined,
  userName: string,
): Promise<string> {
  if (start === undefined) throw new ToolIoError("threads can't be started from here");
  let request: StartThreadRequest;
  try {
    request = startThreadRequest(input);
    await start(request);
  } catch (e) {
    if (e instanceof ThreadError) throw startRefusal(e, input["name"], userName);
    throw e;
  }
  const opened = request.opening === undefined ? "" : " Your opening message is waiting there.";
  const listed = request.folder === undefined ? "" : `the "${request.folder}" folder of `;
  return `Started the thread "${request.name}" (${request.label}).${opened} It's in ${listed}${userName}'s thread list, and ${userName} decides when to switch to it; you're still in this thread.`;
}
