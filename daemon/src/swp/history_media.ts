import type { ServerMessage } from "../protocol/ServerMessage.ts";

export class HistoryMediaDelivery {
  readonly #sent = new Set<string>();

  prepare(message: ServerMessage): ServerMessage {
    if (message.type !== "history") return message;
    if ((message.delta === undefined || message.delta === null)) this.#sent.clear();
    let changed = false;
    const messages = message.messages.map(entry => ({
      ...entry,
      images: entry.images.map(image => {
        if ((image.data === undefined || image.data === null)) return image;
        if ((message.delta !== undefined && message.delta !== null) && this.#sent.has(image.path)) {
          changed = true;
          const { data: _data, ...reference } = image;
          return reference;
        }
        this.#sent.add(image.path);
        return image;
      }),
    }));
    return changed ? { ...message, messages } : message;
  }
}
