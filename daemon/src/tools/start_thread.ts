import { InvalidArgs, ToolIoError } from "./errors.ts";
import { isValidThreadId, MAX_THREAD_ID_LENGTH, ThreadError } from "../engine/threads.ts";

export interface StartThreadRequest {
  name: string;
  label: string;
  purpose?: string;
  files?: string[];
  opening?: string;
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
  const files = input["files"];
  if (files !== undefined && (!Array.isArray(files) || !files.every((file) => typeof file === "string"))) {
    throw new InvalidArgs("files must be a list of workspace paths");
  }
  const purpose = text(input, "purpose");
  const opening = text(input, "opening");
  const paths = files?.map((file) => file.trim()).filter((file) => file !== "") ?? [];
  return {
    name,
    label,
    ...(purpose === undefined ? {} : { purpose }),
    ...(paths.length === 0 ? {} : { files: paths }),
    ...(opening === undefined ? {} : { opening }),
  };
}

export async function handleStartThread(
  input: Record<string, unknown>,
  start: ((request: StartThreadRequest) => Promise<void>) | undefined,
  userName: string,
): Promise<string> {
  if (start === undefined) throw new ToolIoError("threads can't be started from here");
  const request = startThreadRequest(input);
  try {
    await start(request);
  } catch (e) {
    if (e instanceof ThreadError) throw new ToolIoError(e.message);
    throw e;
  }
  const opened = request.opening === undefined ? "" : " Your opening message is waiting there.";
  return `Started the thread "${request.name}" (${request.label}).${opened} It's in ${userName}'s thread list, and ${userName} decides when to switch to it; you're still in this thread.`;
}
