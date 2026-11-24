import { Outbox, postElsewhere, reachableThreads } from "../autonomy/outbox.ts";
import { pushRefusal } from "../autonomy/push.ts";
import { resolveDisplayName } from "../config/app.ts";
import { characterDataDir } from "../config/dirs.ts";
import { hostZone } from "../ledger/zoned.ts";
import { shoreLog } from "../log.ts";
import { sentPicturesDir } from "../storage/sent_pictures.ts";
import { characterWorkspace } from "../tools/character_workspace.ts";
import type { SendMessage } from "../tools/send_message.ts";
import { required } from "../util/required.ts";
import type { ToolAssembly } from "./deps.ts";
import type { SubagentTurn } from "./generation.ts";
import { emitNewMessageEvent } from "./persistence.ts";
import { pictureProblems } from "./pictures.ts";
import type { ToolContextDeps } from "./tool_context.ts";
import { Texts } from "../texts/texts.ts";

export interface ReplyMessages {
  send: SendMessage;
  deliver: () => Promise<void>;
}

export function replyMessages(a: ToolAssembly, character: string, turn: SubagentTurn, push: ToolContextDeps["push"]): ReplyMessages {
  const { runtime } = a;
  const dataDir = runtime.config.dirs.data;
  const config = runtime.registry.effectiveConfig(character);
  const here = required(turn.thread);
  const characterDir = characterDataDir(dataDir, character);
  const workspace = characterWorkspace(config, character);
  const outbox = new Outbox({
    turn: "reply",
    here,
    sealed: false,
    userName: resolveDisplayName(config.app.chat),
    timeZone: hostZone(),
    threads: async () => await reachableThreads(dataDir, character),
    pictureProblems: async (text) => await pictureProblems([text], workspace, turn.signal),
    pushRefusal: () => pushRefusal(characterDir, { topic: config.app.notifications.push_topic, everyMs: config.app.notifications.push_every.asMillis() }, Date.now()),
    texts: Texts.of(config),
  });
  return {
    send: outbox.send,
    deliver: async () => {
      const reply = (await runtime.registry.getOrCreate(character, here)).messages().findLast((message) => message.role === "assistant");
      await postElsewhere(outbox.waiting, {
        character,
        from: here,
        turn: "turn",
        engine: async (thread) => runtime.registry.listThreads(character).some((record) => record.id === thread) ? await runtime.registry.getOrCreate(character, thread) : undefined,
      }, { provider_key: reply?.provider_key, model: reply?.model }, {
        emit: (name, revision, msg, thread) => { if (a.emitEvent !== undefined) emitNewMessageEvent(a.emitEvent, name, "autonomous", revision, msg, thread); },
        notify: (title, shown, picture) => { runtime.notifier.notify("autonomous_message", title, shown, picture); },
        ...(push === undefined ? {} : { push: async (message) => await push(character, message) }),
        newId: turn.newMessageId,
        nowIso: turn.now,
      }, (kind, detail) => { if (kind === "call_failed") shoreLog.warn(`shore: ${detail}`); }, { workspace, dir: sentPicturesDir(dataDir, character) });
    },
  };
}
