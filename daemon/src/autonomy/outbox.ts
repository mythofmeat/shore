import { formatWallClock } from "../engine/prompt.ts";
import { ToolIoError } from "../tools/errors.ts";
import type { SendMessage, SendMessageRequest } from "../tools/send_message.ts";
import type { PushRefusal } from "./push.ts";

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
      throw new ToolIoError(`not sent: these pictures in it could not be sent:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nSend it again with the names fixed.`);
    }
    if (request.push) this.#checkPush();
    this.#waiting.push({ text: request.text, thread, push: request.push });
    const where = thread === here ? "in this thread" : `in "${thread}"`;
    const pushed = request.push ? ` It goes to ${userName}'s phone then too.` : "";
    return `It will be posted ${where} when this ${turn === "wake" ? "wake" : "turn"} ends.${pushed}`;
  };

  async #threadFor(request: SendMessageRequest): Promise<string> {
    const { turn, here, sealed, userName } = this.#setup;
    const thread = request.thread ?? here;
    if (thread === here) {
      if (turn === "reply") throw new ToolIoError(`your reply here is already a message to ${userName}; \`send_message\` is for saying something in another thread, so name one with \`thread\``);
      return here;
    }
    if (sealed) throw new ToolIoError("a wake in a sealed thread sends nothing outside it: leave `thread` out, and the message waits here until the thread opens");
    const known = await this.#setup.threads();
    if (thread === known.wakes) throw new ToolIoError(`"${thread}" is where Shore keeps the working from your wakes, and nothing is sent there`);
    if (known.sealed.includes(thread)) throw new ToolIoError(`"${thread}" is sealed, so only a wake inside it can leave a message there`);
    if (!known.open.includes(thread)) throw new ToolIoError(`you have no thread "${thread}" to send it in; \`threads\` lists the ones you have`);
    return thread;
  }

  #checkPush(): void {
    const { sealed, userName, timeZone } = this.#setup;
    const without = "Send it again without `push` to post it all the same.";
    if (sealed) throw new ToolIoError(`not sent: nothing from a sealed thread is announced before it opens, a push included. ${without}`);
    if (this.#waiting.some((each) => each.push)) throw new ToolIoError(`not sent: a message with a push is already waiting to go when this turn ends, and that push is the one allowed for now. ${without}`);
    const refused = this.#setup.pushRefusal();
    if (refused === undefined) return;
    if (refused.kind === "not_set_up") throw new ToolIoError(`not sent: push notifications aren't set up, because ${userName} hasn't given Shore a topic to send them to. ${without}`);
    throw new ToolIoError(`not sent: your last push was ${formatWallClock(refused.lastAt, timeZone)}, and the next one is allowed from ${formatWallClock(refused.nextAt, timeZone)}. ${without}`);
  }
}
