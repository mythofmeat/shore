import type { ServerMessage } from "../protocol/ServerMessage.ts";

export interface SubagentTaskRecord {
  id: string;
  character: string;
  name: string;
  query: string;
  status: "running" | "done" | "error";
  detail?: string;
}

export interface SubagentTaskStart {
  character: string;
  name: string;
  query: string;
  timeoutMs?: number | undefined;
  run: (task: SubagentTaskRecord, signal: AbortSignal) => Promise<string>;
}

export interface SubagentTaskDeps {
  emit: (message: ServerMessage) => void;
  onSettled: (task: SubagentTaskRecord) => Promise<void> | void;
  newTaskId?: (() => string) | undefined;
  log?: ((msg: string) => void) | undefined;
}

export function subagentStartedAck(record: SubagentTaskRecord): string {
  return (
    `Subagent '${record.name}' started in the background (task ${record.id}). ` +
    `Do not wait for it or poll: its result will arrive on its own as a later ` +
    `message tagged with this task id, and you will get to respond to it then.`
  );
}

export function subagentResultMessage(task: SubagentTaskRecord): string {
  const detail = task.detail ?? "";
  return (
    `<subagent_result task_id="${task.id}" name="${task.name}" status="${task.status}">\n` +
    `<query>\n${task.query}\n</query>\n` +
    `<result>\n${detail}\n</result>\n` +
    `</subagent_result>`
  );
}

const STATUS_DETAIL_MAX_CHARS = 500;

export function statusDetailPreview(detail: string): string {
  const chars = [...detail];
  if (chars.length <= STATUS_DETAIL_MAX_CHARS) return detail;
  return `${chars.slice(0, STATUS_DETAIL_MAX_CHARS).join("")}…`;
}

export class SubagentTaskManager {
  readonly #deps: SubagentTaskDeps;
  readonly #tasks = new Map<string, SubagentTaskRecord>();
  readonly #controllers = new Map<string, AbortController>();
  #closed = false;

  constructor(deps: SubagentTaskDeps) {
    this.#deps = deps;
  }

  start(init: SubagentTaskStart): string {
    const id = this.#deps.newTaskId?.() ?? `sa_${crypto.randomUUID()}`;
    const record: SubagentTaskRecord = {
      id,
      character: init.character,
      name: init.name,
      query: init.query,
      status: "running",
    };
    this.#tasks.set(id, record);

    const controller = new AbortController();
    this.#controllers.set(id, controller);

    const timeoutMs = init.timeoutMs;
    let timedOut = false;
    const timer =
      timeoutMs === undefined || timeoutMs <= 0
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
    timer?.unref?.();

    this.#emit(record);

    void (async () => {
      try {
        const result = await init.run(record, controller.signal);
        record.status = "done";
        record.detail = result;
      } catch (e) {
        record.status = "error";
        record.detail =
          timedOut && timeoutMs !== undefined
            ? `timed out after ${Math.floor(timeoutMs / 1000)}s and was cancelled`
            : e instanceof Error
              ? e.message
              : String(e);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.#controllers.delete(id);
        this.#emit(record);
        if (!this.#closed) {
          try {
            await this.#deps.onSettled(record);
          } catch (e) {
            this.#deps.log?.(
              `shore: subagent '${record.name}' (${id}) result delivery failed: ${String(e)}`,
            );
          }
        }
      }
    })();

    return subagentStartedAck(record);
  }

  tasks(): readonly SubagentTaskRecord[] {
    return [...this.#tasks.values()];
  }

  cancelAll(): void {
    this.#closed = true;
    for (const controller of this.#controllers.values()) controller.abort();
  }

  #emit(task: SubagentTaskRecord): void {
    this.#deps.emit({
      type: "subagent_status",
      task_id: task.id,
      character: task.character,
      name: task.name,
      query: task.query,
      status: task.status,
      ...(task.detail === undefined || task.status === "running"
        ? {}
        : { detail: statusDetailPreview(task.detail) }),
    });
  }
}
