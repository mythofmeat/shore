export interface TextSnapshot { text: string; start: number; end: number; direction: "forward" | "backward" | "none" }
const DEPTH = 200;
const MAX_BYTES = 8 * 1024 * 1024;

export function textSnapshot(text: string, start = text.length, end = start, direction: TextSnapshot["direction"] = "none"): TextSnapshot {
  return { text, start: Math.max(0, Math.min(start, text.length)), end: Math.max(0, Math.min(end, text.length)), direction };
}

export class TextHistory {
  #current = textSnapshot("");
  #past: TextSnapshot[] = [];
  #future: TextSnapshot[] = [];
  #run: string | undefined;
  #composing = false;
  #compositionEdited = false;
  get current(): TextSnapshot { return this.#current; }
  get canUndo(): boolean { return this.#past.length > 0; }
  get canRedo(): boolean { return this.#future.length > 0; }
  reset(text: string): void { this.#current = textSnapshot(text); this.#past = []; this.#future = []; this.#run = undefined; this.#composing = false; this.#compositionEdited = false; }
  breakGroup(): void { this.#run = undefined; }
  beginComposition(): void { this.#composing = true; this.#compositionEdited = false; this.breakGroup(); }
  endComposition(): void { this.#composing = false; this.#compositionEdited = false; this.breakGroup(); }
  select(start: number, end: number, direction: TextSnapshot["direction"]): void {
    if (start !== this.#current.start || end !== this.#current.end) this.#run = undefined;
    this.#current = textSnapshot(this.#current.text, start, end, direction);
  }
  #trim(stack: TextSnapshot[]): void {
    let bytes = stack.reduce((total, item) => total + item.text.length * 2, 0);
    while (stack.length > DEPTH || bytes > MAX_BYTES) bytes -= (stack.shift()?.text.length ?? 0) * 2;
  }
  change(next: TextSnapshot, inputType?: string): void {
    if (next.text === this.#current.text) { this.select(next.start, next.end, next.direction); return; }
    const kind = inputType !== undefined && ["insertText", "insertCompositionText", "deleteContentBackward", "deleteContentForward"].includes(inputType) ? inputType : undefined;
    const continued = this.#composing ? this.#compositionEdited : kind !== undefined && this.#run === kind && this.#current.start === this.#current.end;
    if (!continued) this.#past.push(this.#current);
    this.#compositionEdited = this.#composing;
    this.#future = [];
    this.#trim(this.#past);
    this.#current = next;
    this.#run = kind === "insertText" && /\s$/.test(next.text.slice(0, next.start)) ? undefined : kind;
  }
  step(direction: "undo" | "redo"): TextSnapshot | undefined {
    const source = direction === "undo" ? this.#past : this.#future;
    const target = direction === "undo" ? this.#future : this.#past;
    const next = source.pop();
    if (next === undefined) return undefined;
    target.push(this.#current); this.#trim(target);
    this.#current = next; this.#run = undefined;
    return next;
  }
}
