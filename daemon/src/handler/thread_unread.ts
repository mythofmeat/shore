import { shoreLog } from "../log.ts";
import { MAIN_THREAD } from "../config/dirs.ts";
import { markThreadRead, readThreadsIndex, startReadMarkBefore, threadActivityNow, threadRecord } from "../engine/threads.ts";
import type { ThreadReads } from "../commands/threads.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { ThreadUnread } from "../protocol/ThreadUnread.ts";

export interface ThreadUnreadOptions {
  dataDir: string;
  broadcast: (message: ServerMessage) => void;
  now?: () => number;
}

export class ThreadUnreadTracker implements ThreadReads {
  readonly #data: string;
  readonly #broadcast: (message: ServerMessage) => void;
  readonly #now: () => number;

  constructor(options: ThreadUnreadOptions) {
    this.#data = options.dataDir;
    this.#broadcast = options.broadcast;
    this.#now = options.now ?? Date.now;
  }

  observe(message: ServerMessage): void {
    if (message.type !== "new_message" || typeof message.character !== "string") return;
    const at = Date.parse(message.timestamp);
    if (Number.isNaN(at)) return;
    const character = message.character;
    const thread = message.thread ?? MAIN_THREAD;
    setTimeout(() => { void this.#follow(character, thread, at); }, 0);
  }

  markRead(character: string, thread: string, through: number): ThreadUnread {
    markThreadRead(this.#data, character, thread, Math.min(through, this.#now()));
    return this.#announce(character, thread);
  }

  async #follow(character: string, thread: string, at: number): Promise<void> {
    try {
      const index = await readThreadsIndex(this.#data, character);
      const known = index === undefined ? thread === MAIN_THREAD : threadRecord(index, thread) !== undefined;
      if (!known) return;
      startReadMarkBefore(this.#data, character, thread, at);
      this.#announce(character, thread);
    } catch (e) {
      shoreLog.warn(`shore: could not count unread messages in ${character}/${thread}: ${String(e)}`);
    }
  }

  #announce(character: string, thread: string): ThreadUnread {
    const activity = threadActivityNow(this.#data, character, thread);
    const state: ThreadUnread = {
      character,
      thread,
      unread: activity.unread ?? 0,
      ...(activity.last_active === undefined ? {} : { last_active: activity.last_active }),
    };
    this.#broadcast({ type: "thread_unread", ...state });
    return state;
  }
}
