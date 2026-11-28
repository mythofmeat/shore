import { localDateTime } from "../autonomy/triggers.ts";
import { formatWallClock } from "../engine/prompt.ts";
import type { NewSealedThread } from "../engine/sealed.ts";
import { isValidThreadId, MAX_THREAD_ID_LENGTH, ThreadError } from "../engine/threads.ts";
import { asNaive, resolveInZone } from "../ledger/zoned.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { startRefusal } from "./start_thread.ts";
import type { Texts } from "../texts/texts.ts";

export interface StartedSealedThread {
  unsealAt: string;
  filesDir: string;
}

export function sealedThreadRequest(texts: Texts, input: Record<string, unknown>, timeZone: string): NewSealedThread {
  const id = typeof input["name"] === "string" ? input["name"].trim() : "";
  if (!isValidThreadId(id)) throw new InvalidArgs(texts.always("threads_name_form", { max: String(MAX_THREAD_ID_LENGTH) }));
  const label = typeof input["label"] === "string" ? input["label"].trim() : "";
  if (label === "") throw new InvalidArgs(texts.always("threads_label_required"));
  const local = localDateTime(input["sealed_until"]);
  if (local === undefined) throw new InvalidArgs(texts.always("threads_sealed_until_form"));
  return { id, label, unsealAt: resolveInZone(asNaive(local), timeZone) };
}

export async function handleStartSealedThread(
  texts: Texts,
  input: Record<string, unknown>,
  seal: ((request: NewSealedThread) => Promise<StartedSealedThread>) | undefined,
  userName: string,
  timeZone: string,
): Promise<string> {
  if (seal === undefined) throw new ToolIoError(texts.always("threads_seal_unavailable"));
  const request = sealedThreadRequest(texts, input, timeZone);
  let started: StartedSealedThread;
  try {
    started = await seal(request);
  } catch (e) {
    if (e instanceof ThreadError) throw startRefusal(texts, e, request.id, userName);
    throw e;
  }
  return texts.render("threads_sealed", { name: request.id, label: request.label, opens: formatWallClock(texts, Date.parse(started.unsealAt), timeZone), user: userName, folder: started.filesDir }) ?? "";
}
