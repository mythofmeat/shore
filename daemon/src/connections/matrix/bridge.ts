import type { ServerMessage } from "../../protocol/ServerMessage";

import { parseInput } from "./commands.ts";
import { EventMap } from "./event_map.ts";
import type { MatrixEvent } from "./events.ts";
import { sanitizeFilename } from "./events.ts";
import { formatUserMirror, parseReaction, routeMirror, type MirrorAction, type PendingImage } from "./mirror.ts";
import { ViewPrefs } from "./prefs.ts";
import { renderCommandOutput } from "./render.ts";
import { RoomBindings } from "./rooms.ts";
import type { LocalPeer } from "../../swp/server.ts";
import type { MediaDownloadResult } from "./bot.ts";

export interface BridgeLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface BridgeBot {
  events(): AsyncGenerator<MatrixEvent>;
  sendText(roomId: string, markdown: string): Promise<string | undefined>;
  sendNotice(roomId: string, markdown: string): Promise<string | undefined>;
  editText(roomId: string, eventId: string, markdown: string): Promise<boolean>;
  redact(roomId: string, eventId: string, reason?: string): Promise<void>;
  setTyping(roomId: string, typing: boolean): Promise<void>;
  sendImage(roomId: string, path: string, caption?: string): Promise<string | undefined>;
  downloadMedia(url: string): Promise<MediaDownloadResult>;
}

export interface BridgeOptions {
  readonly bot: BridgeBot;
  readonly attach: (character: string) => Promise<LocalPeer>;
  readonly roster: () => Promise<readonly string[]>;
  readonly rooms: RoomBindings;
  readonly events: EventMap;
  readonly prefs: ViewPrefs;
  readonly mirrorAll: boolean;
  readonly initialRoomId?: string | undefined;
  readonly log?: BridgeLogger;
}

interface PendingEcho {
  readonly roomId: string;
  readonly text: string;
  readonly eventId: string;
}

interface RoomPeer {
  readonly character: string;
  readonly peer: LocalPeer;
  readonly pump: Promise<void>;
}

const MAX_PENDING_ECHOES = 32;

const COMMAND_TIMEOUT_MS = 15_000;

export class Bridge {
  readonly #options: BridgeOptions;
  readonly #echoes: PendingEcho[] = [];
  readonly #silent = new Set<string>();
  readonly #peers = new Map<string, RoomPeer>();
  #nextRid = 1;

  constructor(options: BridgeOptions) {
    this.#options = options;
  }

  async run(): Promise<void> {
    await this.#syncPeers();
    await this.#adoptInitialRoom();
    await this.#pumpMatrix();
    await this.#detachAll();
  }

  async #pumpMatrix(): Promise<void> {
    for await (const event of this.#options.bot.events()) {
      try {
        await this.#onMatrixEvent(event);
      } catch (e) {
        this.#options.log?.warn?.("Matrix event handler failed", {
          kind: event.kind,
          error: String(e),
        });
      }
    }
  }

  async #pumpPeer(peer: LocalPeer, roomId: string): Promise<void> {
    for await (const msg of peer.events()) {
      try {
        await this.#onDaemonFrame(msg, roomId);
      } catch (e) {
        this.#options.log?.warn?.("daemon frame handler failed", {
          type: msg.type,
          error: String(e),
        });
      }
    }
  }

  async #syncPeers(): Promise<void> {
    const bound = new Map(
      this.#options.rooms.entries().map(([character, roomId]) => [roomId, character] as const),
    );
    const stale = new Map<string, RoomPeer>();
    for (const [roomId, attached] of this.#peers) {
      if (bound.get(roomId) !== attached.character) stale.set(roomId, attached);
    }
    for (const [roomId, attached] of stale) {
      this.#peers.delete(roomId);
      await this.#release(attached);
    }
    for (const [roomId, character] of bound) await this.#peerFor(roomId, character);
  }

  async #peerFor(roomId: string, character: string): Promise<LocalPeer | undefined> {
    const attached = this.#peers.get(roomId);
    if (attached !== undefined && attached.character === character) return attached.peer;

    let peer: LocalPeer;
    try {
      peer = await this.#options.attach(character);
    } catch (e) {
      this.#options.log?.warn?.("could not attach a daemon session for a room", {
        room_id: roomId,
        character,
        error: String(e),
      });
      return undefined;
    }
    this.#peers.set(roomId, { character, peer, pump: this.#pumpPeer(peer, roomId) });
    return peer;
  }

  async #release(attached: RoomPeer): Promise<void> {
    await attached.peer.detach();
    await attached.pump;
  }

  async #detachAll(): Promise<void> {
    for (const attached of this.#peers.values()) await this.#release(attached);
    this.#peers.clear();
  }

  async #onMatrixEvent(event: MatrixEvent): Promise<void> {
    switch (event.kind) {
      case "message":
        return await this.#onText(event.roomId, event.eventId, event.text);
      case "image":
        return await this.#onImage(event);
      case "edit":
        return await this.#onEdit(event.roomId, event.targetEventId, event.newText);
      case "redaction":
        return await this.#onRedaction(event.roomId, event.redacts);
      case "reaction":
        return await this.#onReaction(event.roomId, event.targetEventId, event.key);
    }
  }

  async #onText(roomId: string, eventId: string, text: string): Promise<void> {
    const input = parseInput(text);

    switch (input.kind) {
      case "reply":
        await this.#options.bot.sendNotice(roomId, input.text);
        return;

      case "bind":
        return await this.#bind(roomId, input.character);

      case "unbind":
        this.#options.rooms.unbindRoom(roomId);
        await this.#syncPeers();
        await this.#options.bot.sendNotice(roomId, "This room is no longer bound to a character.");
        return;

      case "view":
        return await this.#view(roomId, input.key, input.value);

      case "cancel": {
        const peer = await this.#target(roomId);
        if (peer === undefined) return;
        await peer.send({ type: "cancel" });
        return;
      }

      case "regen": {
        const peer = await this.#target(roomId);
        if (peer === undefined) return;
        await peer.send({ type: "regen", stream: true });
        return;
      }

      case "command": {
        const peer = await this.#target(roomId);
        if (peer === undefined) return;
        await this.#runCommand(peer, input.name, input.args, false);
        return;
      }

      case "text": {
        const peer = await this.#target(roomId);
        if (peer === undefined) return;
        this.#rememberEcho({ roomId, text: input.text, eventId });
        await peer.send({
          type: "message",
          text: input.text,
          stream: true,
          images: [],
          image_data: [],
        });
      }
    }
  }

  async #onImage(event: Extract<MatrixEvent, { kind: "image" }>): Promise<void> {
    const peer = await this.#target(event.roomId);
    if (peer === undefined) return;

    const download = await this.#options.bot.downloadMedia(event.url);
    if (!download.ok) {
      const message =
        download.reason === "too_large"
          ? "That image is larger than Shore's 5 MiB attachment limit."
          : download.reason === "timed_out"
            ? "That image download timed out."
            : "That image could not be downloaded.";
      await this.#options.bot.sendNotice(event.roomId, message);
      return;
    }
    const { bytes } = download;

    const filename = sanitizeFilename(event.body);
    const caption = event.body === filename ? "" : event.body;
    this.#rememberEcho({ roomId: event.roomId, text: caption, eventId: event.eventId });

    await peer.send({
      type: "message",
      text: caption,
      stream: true,
      images: [],
      image_data: [
        {
          filename,
          data: Buffer.from(bytes).toString("base64"),
          ...(event.mimeType === undefined ? {} : { mime_type: event.mimeType }),
        },
      ],
    });
  }

  async #onEdit(roomId: string, targetEventId: string, newText: string): Promise<void> {
    const mapped = this.#options.events.byEventId(targetEventId);
    if (mapped === undefined) {
      await this.#options.bot.sendNotice(roomId, "That message is no longer tracked, so the edit was not applied.");
      return;
    }
    const peer = await this.#target(roomId);
    if (peer === undefined) return;
    await this.#runCommand(peer, "edit", { ref: mapped.msgId, content: newText }, true);
    this.#options.events.updateContent(mapped.msgId, newText);
  }

  async #onRedaction(roomId: string, redacts: string): Promise<void> {
    const mapped = this.#options.events.byEventId(redacts);
    if (mapped === undefined) return;
    const peer = await this.#target(roomId);
    if (peer === undefined) return;
    await this.#runCommand(peer, "delete", { refs: [mapped.msgId] }, true);
    this.#options.events.removeEvent(redacts);
  }

  async #onReaction(roomId: string, targetEventId: string, key: string): Promise<void> {
    const control = parseReaction(key);
    if (control === undefined) return;
    const mapped = this.#options.events.byEventId(targetEventId);
    if (mapped === undefined) return;
    const peer = await this.#target(roomId);
    if (peer === undefined) return;

    switch (control) {
      case "regen": {
        const latest = this.#options.events.latestReplyInRoom(roomId);
        if (latest?.eventId !== targetEventId) {
          await this.#options.bot.sendNotice(roomId, "Only the most recent reply can be regenerated.");
          return;
        }
        await peer.send({ type: "regen", stream: true });
        return;
      }
      case "delete":
        await this.#runCommand(peer, "delete", { refs: [mapped.msgId] }, true);
        this.#options.events.removeEvent(targetEventId);
        await this.#options.bot.redact(roomId, targetEventId, "deleted from shore");
        return;
      case "alt_prev":
      case "alt_next":
        await this.#runCommand(
          peer,
          "alt",
          { ref: mapped.msgId, direction: control === "alt_prev" ? "prev" : "next" },
          false,
        );
    }
  }

  async #adoptInitialRoom(): Promise<void> {
    const roomId = this.#options.initialRoomId;
    if (roomId === undefined || roomId === "" || this.#options.rooms.isBound(roomId)) return;

    const characters = await this.#options.roster();
    const only = characters.length === 1 ? characters[0] : undefined;
    if (only === undefined) {
      await this.#options.bot.sendNotice(
        roomId,
        "This room is not bound to a character yet. Use `!bind <character>` — `!bind` on its own lists them.",
      );
      return;
    }
    if (!(await this.#persistBinding(roomId, only))) return;
    await this.#options.bot.sendNotice(roomId, `This room is now bound to **${only}**.`);
  }

  async #bind(roomId: string, character: string | undefined): Promise<void> {
    const characters = await this.#options.roster();

    if (character === undefined) {
      const bound = this.#options.rooms.characterForRoom(roomId);
      const list = characters.map((name) => `- \`${name}\``).join("\n");
      await this.#options.bot.sendNotice(
        roomId,
        [
          bound === undefined ? "This room is not bound." : `This room is bound to **${bound}**.`,
          characters.length === 0 ? "_No characters available._" : `Available:\n${list}`,
          "Bind with `!bind <character>`.",
        ].join("\n\n"),
      );
      return;
    }

    if (!characters.includes(character)) {
      await this.#options.bot.sendNotice(roomId, `No such character: \`${character}\`.`);
      return;
    }
    if (!(await this.#persistBinding(roomId, character))) return;
    await this.#options.bot.sendNotice(roomId, `This room is now bound to **${character}**.`);
  }

  async #persistBinding(roomId: string, character: string): Promise<boolean> {
    try {
      this.#options.rooms.bind(roomId, character);
    } catch (e) {
      this.#options.log?.warn?.("failed to persist room binding", {
        room_id: roomId,
        character,
        error: String(e),
      });
      await this.#options.bot.sendNotice(
        roomId,
        `Could not save that binding, so it would not survive a restart: ${String(e)}`,
      );
      return false;
    }
    await this.#syncPeers();
    return true;
  }

  async #view(roomId: string, key: string | undefined, value: boolean | undefined): Promise<void> {
    if (key === undefined) {
      const view = this.#options.prefs.room(roomId);
      const lines = Object.entries(view).map(([k, v]) => `- ${k}: ${v ? "on" : "off"}`);
      await this.#options.bot.sendNotice(roomId, `**This room shows**\n${lines.join("\n")}`);
      return;
    }
    const now = this.#options.prefs.set(roomId, key, value);
    await this.#options.bot.sendNotice(
      roomId,
      now === undefined ? `Unknown view key: \`${key}\`.` : `\`${key}\` is now ${now ? "on" : "off"}.`,
    );
  }

  async #target(roomId: string): Promise<LocalPeer | undefined> {
    const character = this.#options.rooms.characterForRoom(roomId);
    if (character === undefined) {
      await this.#options.bot.sendNotice(roomId, "This room is not bound. Use `!bind <character>`.");
      return undefined;
    }
    const peer = await this.#peerFor(roomId, character);
    if (peer === undefined) {
      await this.#options.bot.sendNotice(roomId, `Could not reach the daemon for **${character}**.`);
    }
    return peer;
  }

  async #runCommand(
    peer: LocalPeer,
    name: string,
    args: Record<string, unknown>,
    silent: boolean,
  ): Promise<void> {
    const rid = `matrix-${this.#nextRid}`;
    this.#nextRid += 1;
    if (silent) {
      this.#silent.add(rid);
      this.#expire(rid);
    }
    await peer.send({ type: "command", rid, name, args });
  }

  #expire(rid: string): void {
    const timer = setTimeout(() => {
      if (!this.#silent.delete(rid)) return;
      this.#options.log?.warn?.("no answer from the daemon", { rid });
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
  }

  async #onDaemonFrame(msg: ServerMessage, roomId: string): Promise<void> {
    const rid = "rid" in msg ? (msg.rid ?? undefined) : undefined;
    if (
      rid !== undefined &&
      (msg.type === "command_output" || msg.type === "error") &&
      this.#silent.delete(rid)
    ) {
      if (msg.type === "error") await this.#options.bot.sendNotice(roomId, `⚠️ ${msg.message}`);
      return;
    }

    const action = routeMirror(msg);

    switch (action.kind) {
      case "start_typing":
        return await this.#options.bot.setTyping(roomId, true);
      case "stop_typing":
        return await this.#options.bot.setTyping(roomId, false);
      case "post":
        return await this.#post(roomId, action);
      case "user_prompt":
        return await this.#mirrorPrompt(roomId, action.msgId, action.content);
      case "command_output":
        return void (await this.#options.bot.sendNotice(
          roomId,
          renderCommandOutput(action.name, action.data),
        ));
      case "error":
      case "notice":
        return void (await this.#options.bot.sendNotice(roomId, action.text));
      case "none":
    }
  }

  async #post(roomId: string, action: Extract<MirrorAction, { kind: "post" }>): Promise<void> {
    const body = this.#withThinking(roomId, action.text, action.thinking);

    if (action.replacesLast) {
      const previous =
        (action.msgId === undefined ? undefined : this.#options.events.byMsgId(action.msgId)) ??
        this.#options.events.latestReplyInRoom(roomId);
      if (previous !== undefined && (await this.#options.bot.editText(roomId, previous.eventId, body))) {
        if (action.msgId !== undefined) {
          this.#options.events.record({
            msgId: action.msgId,
            roomId,
            eventId: previous.eventId,
            origin: "assistant",
            content: action.text,
          });
        }
        await this.#sendImages(roomId, action.images);
        return;
      }
    }

    const eventId = await this.#options.bot.sendText(roomId, body);
    if (eventId !== undefined && action.msgId !== undefined) {
      this.#options.events.record({
        msgId: action.msgId,
        roomId,
        eventId,
        origin: "assistant",
        content: action.text,
      });
    }
    await this.#sendImages(roomId, action.images);
  }

  #withThinking(roomId: string, text: string, thinking: string | undefined): string {
    if (thinking === undefined || !this.#options.prefs.room(roomId).thinking) return text;
    const quoted = thinking
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `${quoted}\n\n${text}`;
  }

  async #sendImages(roomId: string, images: readonly PendingImage[]): Promise<void> {
    for (const image of images) {
      await this.#options.bot.sendImage(roomId, image.path, image.caption);
    }
  }

  async #mirrorPrompt(
    roomId: string,
    msgId: string | undefined,
    content: string,
  ): Promise<void> {
    const echo = this.#takeEcho(roomId, content);
    if (echo !== undefined) {
      if (msgId !== undefined) {
        this.#options.events.record({
          msgId,
          roomId,
          eventId: echo.eventId,
          origin: "matrix_user",
          content,
        });
      }
      return;
    }

    if (!this.#options.mirrorAll) return;

    const eventId = await this.#options.bot.sendNotice(roomId, formatUserMirror(content));
    if (eventId !== undefined && msgId !== undefined) {
      this.#options.events.record({
        msgId,
        roomId,
        eventId,
        origin: "mirrored_user",
        content,
      });
    }
  }

  #rememberEcho(echo: PendingEcho): void {
    this.#echoes.push(echo);
    if (this.#echoes.length > MAX_PENDING_ECHOES) this.#echoes.shift();
  }

  #takeEcho(roomId: string, content: string): PendingEcho | undefined {
    const at = this.#echoes.findIndex((e) => e.roomId === roomId && e.text === content);
    if (at === -1) return undefined;
    const [echo] = this.#echoes.splice(at, 1);
    return echo;
  }
}
