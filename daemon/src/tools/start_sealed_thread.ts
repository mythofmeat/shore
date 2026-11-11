import { localDateTime } from "../autonomy/triggers.ts";
import { formatWallClock } from "../engine/prompt.ts";
import type { NewSealedThread } from "../engine/sealed.ts";
import { isValidThreadId, MAX_THREAD_ID_LENGTH, ThreadError } from "../engine/threads.ts";
import { asNaive, resolveInZone } from "../ledger/zoned.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";

export interface StartedSealedThread {
  unsealAt: string;
  filesDir: string;
}

export function sealedThreadRequest(input: Record<string, unknown>, timeZone: string): NewSealedThread {
  const id = typeof input["name"] === "string" ? input["name"].trim() : "";
  if (!isValidThreadId(id)) {
    throw new InvalidArgs(`name must be letters, digits, dot, dash or underscore, starting with a letter or digit, at most ${String(MAX_THREAD_ID_LENGTH)} characters`);
  }
  const label = typeof input["label"] === "string" ? input["label"].trim() : "";
  if (label === "") throw new InvalidArgs("label is required");
  const local = localDateTime(input["opens"]);
  if (local === undefined) throw new InvalidArgs('opens must be a local date and 24-hour time, like "2026-12-24 08:00"');
  return { id, label, unsealAt: resolveInZone(asNaive(local), timeZone) };
}

export async function handleStartSealedThread(
  input: Record<string, unknown>,
  seal: ((request: NewSealedThread) => Promise<StartedSealedThread>) | undefined,
  userName: string,
  timeZone: string,
): Promise<string> {
  if (seal === undefined) throw new ToolIoError("sealed threads can't be started from here");
  const request = sealedThreadRequest(input, timeZone);
  let started: StartedSealedThread;
  try {
    started = await seal(request);
  } catch (e) {
    if (e instanceof ThreadError) throw new ToolIoError(e.message);
    throw e;
  }
  const opens = formatWallClock(Date.parse(started.unsealAt), timeZone);
  return `Sealed the thread "${request.id}" (${request.label}) until ${opens}. ${userName} can't see it until then, and your other turns are shown only its label and that time. ` +
    `\`wake_in_thread\` takes you into it. Keep what you make for it in ${started.filesDir}, which is outside your workspace.`;
}
