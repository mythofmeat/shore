import { characterDataDir } from "../config/dirs.ts";
import { pictureText } from "../engine/embeds.ts";
import { formatWallClock } from "../engine/prompt.ts";
import { sealedThreads } from "../engine/sealed_list.ts";
import { homeThread, readThreadsIndex, threadsTheCharacterSees, wakesThread } from "../engine/threads.ts";
import type { Message } from "../engine/types.ts";
import { newMessageVersion } from "../engine/versions.ts";
import { firstSentPicture, sendPictures, type PictureSender } from "../handler/pictures.ts";
import { shoreLog } from "../log.ts";
import { truncateSummary, type NotificationPicture } from "../notifications.ts";
import { ToolIoError } from "../tools/errors.ts";
import type { SendMessage, SendMessageRequest } from "../tools/send_message.ts";
import type { PushOutcome, PushRefusal } from "./push.ts";
import type { Texts } from "../texts/texts.ts";

export interface Outgoing {
  text: string;
  thread: string;
  push: boolean;
}

export interface ReachableThreads {
  open: readonly string[];
  wakes: string | undefined;
  sealed: readonly string[];
}

export interface OutboxSetup {
  turn: "wake" | "reply";
  here: string;
  sealed: boolean;
  userName: string;
  timeZone: string;
  threads: () => Promise<ReachableThreads>;
  pictureProblems: (text: string) => Promise<string[]>;
  pushRefusal: () => PushRefusal | undefined;
  texts: Texts;
}

export class Outbox {
  readonly #setup: OutboxSetup;
  readonly #waiting: Outgoing[] = [];

  constructor(setup: OutboxSetup) {
    this.#setup = setup;
  }

  get waiting(): readonly Outgoing[] {
    return this.#waiting;
  }

  readonly send: SendMessage = async (request) => {
    const { turn, here, userName } = this.#setup;
    const thread = await this.#threadFor(request);
    const problems = await this.#setup.pictureProblems(request.text);
    if (problems.length > 0) {
      throw new ToolIoError(this.#setup.texts.always("send_refused", { pictures: problems.map((problem) => `- ${problem}`).join("\n") }));
    }
    if (request.push) this.#checkPush();
    this.#waiting.push({ text: request.text, thread, push: request.push });
    return this.#setup.texts.render("send_queued", { here: thread === here ? "yes" : undefined, thread, wake: turn === "wake" ? "yes" : undefined, push: request.push ? "yes" : undefined, user: userName }) ?? "";
  };

  async #threadFor(request: SendMessageRequest): Promise<string> {
    const { turn, here, sealed, userName, texts } = this.#setup;
    const thread = request.thread ?? here;
    if (thread === here) {
      if (turn === "reply") throw new ToolIoError(texts.always("send_in_reply", { user: userName }));
      return here;
    }
    if (sealed) throw new ToolIoError(texts.always("send_out_of_seal"));
    const known = await this.#setup.threads();
    if (thread === known.wakes) throw new ToolIoError(texts.always("send_to_wakes", { thread }));
    if (known.sealed.includes(thread)) throw new ToolIoError(texts.always("send_to_sealed", { thread }));
    if (!known.open.includes(thread)) throw new ToolIoError(texts.always("send_no_thread", { thread }));
    return thread;
  }

  #checkPush(): void {
    const { sealed, userName, timeZone, texts } = this.#setup;
    if (sealed) throw new ToolIoError(texts.always("send_push_sealed"));
    if (this.#waiting.some((each) => each.push)) throw new ToolIoError(texts.always("send_push_waiting"));
    const refused = this.#setup.pushRefusal();
    if (refused === undefined) return;
    if (refused.kind === "not_set_up") throw new ToolIoError(texts.always("send_push_not_set_up", { user: userName }));
    throw new ToolIoError(texts.always("send_push_too_soon", { last: formatWallClock(refused.lastAt, timeZone), next: formatWallClock(refused.nextAt, timeZone) }));
  }
}

export async function reachableThreads(dataDir: string, character: string): Promise<ReachableThreads> {
  const index = await readThreadsIndex(dataDir, character);
  return {
    open: index === undefined ? [homeThread(index)] : threadsTheCharacterSees(index.threads).map((each) => each.id),
    wakes: wakesThread(index),
    sealed: sealedThreads(characterDataDir(dataDir, character)).map((each) => each.id),
  };
}

function shortPreview(text: string): string {
  return Array.from(text).slice(0, 80).join("");
}

export interface PostTo {
  thread: string;
  engine: { appendMessage(msg: Message): Promise<void>; currentRevision(): number };
}

export type Sending = Pick<Outgoing, "text" | "push">;

export interface Poster {
  emit?: (character: string, revision: number, msg: Message, thread: string) => void;
  notify?: (title: string, body: string, picture?: NotificationPicture) => void;
  push?: (message: string) => Promise<PushOutcome>;
  newId?: () => string;
  nowIso?: () => string;
}

export type PostNote = (kind: "message_sent" | "call_failed", detail: string) => void;

export interface Sender {
  provider_key?: string | undefined;
  model?: string | undefined;
}

export async function postMessage(
  character: string,
  from: Sender,
  sending: Sending,
  deps: Poster,
  note: PostNote,
  to: PostTo,
  pictures: PictureSender,
): Promise<Message | undefined> {
  const msg: Message = {
    msg_id: (deps.newId ?? (() => `m_${crypto.randomUUID()}`))(),
    origin: "autonomous",
    role: "assistant",
    content: sending.text,
    images: [],
    content_blocks: [{ type: "text", text: sending.text }],
    alternatives: [],
    ...(from.provider_key === undefined ? {} : { provider_key: from.provider_key }),
    ...(from.model === undefined || from.model === "" ? {} : { model: from.model }),
    timestamp: (deps.nowIso ?? (() => new Date().toISOString()))(),
    version: newMessageVersion(),
  };
  msg.images.push(...await sendPictures([sending.text], pictures));

  let persisted: Message | undefined;
  try {
    await to.engine.appendMessage(msg);
    persisted = msg;
    deps.emit?.(character, to.engine.currentRevision(), msg, to.thread);
  } catch (e) {
    shoreLog.error(`shore: a message for ${character} could not be delivered to ${to.thread}: ${String(e)}`);
  }

  const shown = pictureText(msg.content, msg.images);
  deps.notify?.(`Shore - ${character}`, shown, firstSentPicture(msg.images));
  note("message_sent", `Autonomous message sent: ${shortPreview(shown)}`);
  if (sending.push) {
    try {
      const outcome = await deps.push?.(shown);
      if (outcome?.kind !== "sent") note("call_failed", "The push that went with a message was not sent: by then a push was no longer allowed");
    } catch (error) {
      note("call_failed", `The push that went with a message failed: ${truncateSummary(String(error), 120)}`);
    }
  }
  return persisted;
}

export interface Elsewhere {
  character: string;
  from: string;
  turn: "wake" | "turn";
  engine: (thread: string) => Promise<PostTo["engine"] | undefined>;
}

export async function postElsewhere(
  away: readonly Outgoing[],
  where: Elsewhere,
  request: Sender,
  deps: Poster,
  note: PostNote,
  pictures: PictureSender,
): Promise<void> {
  for (const each of away) {
    const engine = await where.engine(each.thread);
    if (engine === undefined) {
      note("call_failed", `A message for the thread "${each.thread}" was not sent: that thread was gone by the time the ${where.turn} in "${where.from}" ended`);
      continue;
    }
    await postMessage(where.character, request, each, deps, note, { thread: each.thread, engine }, pictures);
  }
}
