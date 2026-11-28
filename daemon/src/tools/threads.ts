import type { NewSealedThread } from "../engine/sealed.ts";
import type { ThreadRecord } from "../engine/threads.ts";
import { actionOf } from "./actions.ts";
import { handleEditThread, type EditThreadRequest } from "./edit_thread.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import { handleListThreads, type ListThreadsOptions } from "./list_threads.ts";
import { handleStartSealedThread, type StartedSealedThread } from "./start_sealed_thread.ts";
import { handleStartThread, type StartThreadRequest } from "./start_thread.ts";

const TAKES = {
  list: [],
  start: ["name", "label", "purpose", "pins", "opening", "folder", "sealed_until"],
  edit: ["name", "label", "purpose", "pins"],
} as const;

const NOT_SEALED_IN = ["purpose", "pins", "opening", "folder"];

export interface ThreadsTool {
  list: ListThreadsOptions;
  timeZone: string;
  dryRun?: boolean | undefined;
  start?: ((request: StartThreadRequest) => Promise<void>) | undefined;
  seal?: ((request: NewSealedThread) => Promise<StartedSealedThread>) | undefined;
  edit?: ((request: EditThreadRequest) => Promise<ThreadRecord | undefined>) | undefined;
}

export async function handleThreads(input: Record<string, unknown>, tool: ThreadsTool): Promise<string> {
  const texts = tool.list.texts;
  const action = actionOf(texts, input, TAKES);
  if (action === "list") return await handleListThreads(tool.list);
  if (tool.dryRun === true) throw new ToolIoError(texts.always("tool_dry_run", { tool: `threads ${action}` }));
  const user = tool.list.userName;
  if (action === "edit") return await handleEditThread(texts, input, tool.edit, user);
  if (!("sealed_until" in input)) return await handleStartThread(texts, input, tool.start, user);
  const given = NOT_SEALED_IN.filter((field) => field in input);
  if (given.length > 0) throw new InvalidArgs(texts.always("threads_sealed_takes", { fields: given.join(" or "), user }));
  return await handleStartSealedThread(texts, input, tool.seal, user, tool.timeZone);
}
