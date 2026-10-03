import type { ThreadView } from "../protocol/ThreadView.ts";
import type { ThreadListing } from "../protocol/ThreadListing.ts";
import type { ThreadSelection } from "../protocol/ThreadSelection.ts";
import type { ThreadForkResult } from "../protocol/ThreadForkResult.ts";
export type { ThreadListing, ThreadForkResult };
import type { Args } from "./navigation.ts";
import { busy, invalidRequest, notFound } from "./errors.ts";
import {
  ThreadError,
  type ArchiveThreadOptions,
  type NewThread,
  type ThreadActivity,
  type ThreadRecord,
  type ThreadsIndex,
} from "../engine/threads.ts";
import { ForkBusy, type ForkResult, type ForkThreadOptions } from "../engine/fork.ts";

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidRequest(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export interface ThreadRegistry {
  listThreads(character: string): readonly ThreadRecord[];
  homeThread(character: string): string;
  createThread(
    character: string,
    id: string,
    options?: NewThread,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  archiveThread(
    character: string,
    id: string,
    options?: ArchiveThreadOptions,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  setHomeThread(character: string, id: string, signal?: AbortSignal): Promise<ThreadsIndex>;
  setThreadLabel(
    character: string,
    id: string,
    label: string | undefined,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  setThreadModel(
    character: string,
    id: string,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<ThreadsIndex>;
  forkThread(
    character: string,
    source: string,
    child: string,
    options?: ForkThreadOptions,
    signal?: AbortSignal,
  ): Promise<ForkResult>;
}

export interface ThreadContext {
  registry: ThreadRegistry;
  character: string;
  current: string;
  activity?: ReadonlyMap<string, ThreadActivity>;
  warm?: string;
  signal?: AbortSignal;
  withSnapshot?: <T>(run: () => Promise<T>) => Promise<T>;
}

function threadCommandError(e: unknown): unknown {
  if (e instanceof ForkBusy) return busy(e.message);
  if (!(e instanceof ThreadError)) return e;
  return e.kind === "not_found" ? notFound(e.message) : invalidRequest(e.message);
}

function view(ctx: ThreadContext, record: ThreadRecord, home: string, current: string): ThreadView {
  const activity = ctx.activity?.get(record.id);
  return {
    ...record,
    home: record.id === home,
    current: record.id === current,
    ...(ctx.activity === undefined ? {} : { turns: activity?.turns ?? 0 }),
    ...(activity?.last_active === undefined ? {} : { last_active: activity.last_active }),
    ...(ctx.warm === record.id ? { warm: true } : {}),
  };
}

function listing(ctx: ThreadContext, index?: ThreadsIndex): ThreadListing {
  const home = index?.home ?? ctx.registry.homeThread(ctx.character);
  const records = index?.threads ?? ctx.registry.listThreads(ctx.character);
  const current = records.some((t) => t.id === ctx.current) ? ctx.current : home;
  return {
    character: ctx.character,
    threads: records.map((record) => view(ctx, record, home, current)),
    home,
    current,
  };
}

export function listThreads(ctx: ThreadContext): ThreadListing {
  return listing(ctx);
}

function requiredId(args: Args): string {
  const id = asStr(args["name"]);
  if (id === undefined) throw invalidRequest("Missing required argument: name");
  return id;
}

export type ThreadSwitch = ThreadSelection;

export function switchThread(ctx: ThreadContext, args: Args): ThreadSwitch {
  const id = requiredId(args);
  if (id === ctx.current) return { character: ctx.character, thread: id, changed: false };
  if (!ctx.registry.listThreads(ctx.character).some((t) => t.id === id)) {
    throw notFound(`Thread not found: ${id}`);
  }
  return { character: ctx.character, thread: id, changed: true };
}

export async function newThread(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const label = optionalText(args["label"], "label");
  const model = optionalText(args["model"], "model");
  const options: NewThread = {
    ...(label === undefined ? {} : { label }),
    ...(model === undefined ? {} : { chat_model: model }),
    ...(args["compaction"] === true ? { compaction: true } : {}),
  };
  try {
    return listing(ctx, await ctx.registry.createThread(ctx.character, id, options, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function archiveThread(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  try {
    return listing(ctx, await ctx.registry.archiveThread(ctx.character, id, undefined, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadHome(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  try {
    return listing(ctx, await ctx.registry.setHomeThread(ctx.character, id, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadLabel(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const label = optionalText(args["label"], "label");
  try {
    return listing(ctx, await ctx.registry.setThreadLabel(ctx.character, id, label, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

export async function threadModel(ctx: ThreadContext, args: Args): Promise<ThreadListing> {
  const id = requiredId(args);
  const model = optionalText(args["model"], "model");
  try {
    return listing(ctx, await ctx.registry.setThreadModel(ctx.character, id, model, ctx.signal));
  } catch (e) {
    throw threadCommandError(e);
  }
}

function requestedTurns(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidRequest("turns must be a positive whole number of turns");
  }
  return value;
}

export async function forkThread(ctx: ThreadContext, args: Args): Promise<ThreadForkResult> {
  const id = requiredId(args);
  const from = optionalText(args["from"], "from") ?? ctx.current;
  const turns = requestedTurns(args["turns"]);
  const run = async (): Promise<ForkResult> =>
    await ctx.registry.forkThread(
      ctx.character,
      from,
      id,
      turns === undefined ? {} : { turns },
      ctx.signal,
    );
  try {
    const result = ctx.withSnapshot === undefined ? await run() : await ctx.withSnapshot(run);
    return {
      ...listing(ctx, result.index),
      fork: {
        fork_id: result.fork.fork_id,
        thread: result.fork.child,
        source: result.fork.source,
        created_at: result.fork.created_at,
        messages: result.fork.message_count,
        turns: result.fork.turn_count,
        scope: turns === undefined ? "full" : "last_turns",
        ...(turns === undefined ? {} : { requested_turns: turns }),
      },
    };
  } catch (e) {
    throw threadCommandError(e);
  }
}
