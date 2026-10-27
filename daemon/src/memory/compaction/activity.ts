import { characterDataDir } from "../../config/dirs.ts";
import { abortRejection } from "../../llm/abort.ts";
import type { FrameSink } from "../../llm/stream.ts";
import type { CompactionTrigger } from "../../protocol/CompactionTrigger.ts";
import type { ServerMessage } from "../../protocol/ServerMessage.ts";
import type { CompactionOutcome } from "./types.ts";

export type PassEnd =
  | { kind: "outcome"; outcome: CompactionOutcome | undefined }
  | { kind: "failed"; error: string };

export interface PassInfo {
  character: string;
  thread: string;
  trigger: CompactionTrigger;
  startedAt: number;
}

export interface EndedPass extends PassInfo {
  endedAt: number;
  end: PassEnd;
}

export interface RunningPassView extends PassInfo {
  phase: string | undefined;
  lastTool: string | undefined;
}

interface RunningPass extends RunningPassView {
  dataDir: string;
  frames: ServerMessage[];
  watchers: Set<FrameSink>;
  controller: AbortController;
  ended: Promise<EndedPass>;
  settle: (ended: EndedPass) => void;
}

export interface PassHandle {
  readonly emit: FrameSink;
  readonly signal: AbortSignal;
  finish(outcome: CompactionOutcome | undefined): void;
  fail(error: unknown): void;
}

const running = new Map<string, RunningPass>();
const lastEnded = new Map<string, EndedPass>();

export type PassEvent =
  | { kind: "phase"; pass: RunningPassView }
  | { kind: "ended"; ended: EndedPass };

type PassListener = (dataDir: string, event: PassEvent) => void;
const listeners = new Set<PassListener>();

export function observePasses(listener: PassListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tell(dataDir: string, event: PassEvent): void {
  for (const listener of listeners) {
    try {
      listener(dataDir, event);
    } catch {
      continue;
    }
  }
}

export function startPass(
  dataDir: string,
  info: PassInfo,
  upstream?: FrameSink,
  signal?: AbortSignal,
  now: () => number = Date.now,
): PassHandle {
  const key = characterDataDir(dataDir, info.character);
  const controller = new AbortController();
  const { promise: ended, resolve: settle } = Promise.withResolvers<EndedPass>();
  const pass: RunningPass = {
    ...info, dataDir, phase: "compacting", lastTool: undefined,
    frames: [], watchers: new Set(), controller, ended, settle,
  };
  running.set(key, pass);
  tell(dataDir, { kind: "phase", pass: passView(pass) });
  let closed = false;
  const close = (end: PassEnd): void => {
    if (closed) return;
    closed = true;
    if (running.get(key) === pass) running.delete(key);
    const record = { ...info, endedAt: now(), end };
    if (end.kind === "failed" || end.outcome !== undefined) lastEnded.set(key, record);
    pass.settle(record);
    tell(dataDir, { kind: "ended", ended: record });
  };
  return {
    emit: (frame) => {
      publish(pass, frame);
      upstream?.(frame);
    },
    signal: signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
    finish: (outcome) => close({ kind: "outcome", outcome }),
    fail: (error) => close({ kind: "failed", error: error instanceof Error ? error.message : String(error) }),
  };
}

function publish(pass: RunningPass, frame: ServerMessage): void {
  if (frame.type === "phase") {
    pass.phase = frame.phase;
    tell(pass.dataDir, { kind: "phase", pass: passView(pass) });
  }
  if (frame.type === "tool_call") pass.lastTool = frame.tool_name;
  const previous = pass.frames.at(-1);
  if (
    frame.type === "stream_chunk" && previous?.type === "stream_chunk" &&
    previous.content_type === frame.content_type && previous.subagent === frame.subagent && previous.task_id === frame.task_id
  ) {
    pass.frames[pass.frames.length - 1] = { ...previous, text: previous.text + frame.text };
  } else {
    pass.frames.push(frame);
  }
  for (const watcher of pass.watchers) watcher(frame);
}

export async function watchPass(
  dataDir: string,
  character: string,
  sink: FrameSink,
  signal?: AbortSignal,
): Promise<EndedPass | undefined> {
  const pass = running.get(characterDataDir(dataDir, character));
  if (pass === undefined) return undefined;
  for (const frame of pass.frames) sink(frame);
  pass.watchers.add(sink);
  try {
    return await untilAborted(pass.ended, signal);
  } finally {
    pass.watchers.delete(sink);
  }
}

export async function cancelPass(dataDir: string, character: string, reason: string): Promise<EndedPass | undefined> {
  const pass = running.get(characterDataDir(dataDir, character));
  if (pass === undefined) return undefined;
  pass.controller.abort(new DOMException(reason, "AbortError"));
  return await pass.ended;
}

export async function passEnded(dataDir: string, character: string): Promise<void> {
  for (let pass = running.get(characterDataDir(dataDir, character)); pass !== undefined; pass = running.get(characterDataDir(dataDir, character))) {
    await pass.ended;
  }
}

export async function cancelAllPasses(dataDir: string, reason: string): Promise<void> {
  const passes = [...running].filter(([key, pass]) => key === characterDataDir(dataDir, pass.character)).map(([, pass]) => pass);
  await Promise.all(passes.map(async (pass) => {
    pass.controller.abort(new DOMException(reason, "AbortError"));
    await pass.ended;
  }));
}

export function runningPass(dataDir: string, character: string): RunningPassView | undefined {
  const pass = running.get(characterDataDir(dataDir, character));
  return pass === undefined ? undefined : passView(pass);
}

export function runningPasses(dataDir: string): RunningPassView[] {
  return [...running]
    .filter(([key, pass]) => key === characterDataDir(dataDir, pass.character))
    .map(([, pass]) => passView(pass));
}

function passView(pass: RunningPass): RunningPassView {
  return { character: pass.character, thread: pass.thread, trigger: pass.trigger, startedAt: pass.startedAt, phase: pass.phase, lastTool: pass.lastTool };
}

export function lastPass(dataDir: string, character: string): EndedPass | undefined {
  return lastEnded.get(characterDataDir(dataDir, character));
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await work;
  signal.throwIfAborted();
  const rejection = abortRejection(signal);
  try {
    return await Promise.race([work, rejection.promise]);
  } finally {
    rejection.dispose();
  }
}
