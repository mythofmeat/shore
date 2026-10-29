import { InvalidArgs, ToolIoError } from "./errors.ts";
import { ThreadError, type ThreadEdit, type ThreadRecord } from "../engine/threads.ts";

export interface EditThreadRequest extends ThreadEdit {
  name: string;
}

function setting(input: Record<string, unknown>, field: string): string | null | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new InvalidArgs(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function fileList(input: Record<string, unknown>): string[] | undefined {
  const files = input["files"];
  if (files === undefined || files === null) return undefined;
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
    throw new InvalidArgs("files must be a list of workspace paths");
  }
  return files.map((file) => file.trim()).filter((file) => file !== "");
}

export function editThreadRequest(input: Record<string, unknown>): EditThreadRequest {
  const name = typeof input["name"] === "string" ? input["name"].trim() : "";
  if (name === "") throw new InvalidArgs("name is required: the id of the thread to change");
  const label = setting(input, "label");
  const purpose = setting(input, "purpose");
  const files = fileList(input);
  if (label === undefined && purpose === undefined && files === undefined) {
    throw new InvalidArgs("give at least one of label, purpose or files to change");
  }
  return {
    name,
    ...(label === undefined ? {} : { label }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(files === undefined ? {} : { files }),
  };
}

function changes(request: EditThreadRequest, record: ThreadRecord | undefined): string[] {
  return [
    ...(request.label === undefined ? [] : [record?.label === undefined ? "label cleared" : `label "${record.label}"`]),
    ...(request.purpose === undefined ? [] : [record?.purpose === undefined ? "purpose cleared" : "purpose set"]),
    ...(request.files === undefined ? [] : [record?.files === undefined ? "files cleared" : `files ${record.files.join(", ")}`]),
  ];
}

export async function handleEditThread(
  input: Record<string, unknown>,
  edit: ((request: EditThreadRequest) => Promise<ThreadRecord | undefined>) | undefined,
  userName: string,
): Promise<string> {
  if (edit === undefined) throw new ToolIoError("threads can't be edited from here");
  const request = editThreadRequest(input);
  let record: ThreadRecord | undefined;
  try {
    record = await edit(request);
  } catch (e) {
    if (!(e instanceof ThreadError)) throw e;
    if (e.kind === "locked") {
      throw new ToolIoError(
        `Nothing changed: ${userName} locked the thread "${request.name}", so its label, purpose and files change only when ${userName} changes them.`,
      );
    }
    throw new ToolIoError(e.message);
  }
  return `Changed the thread "${request.name}": ${changes(request, record).join("; ")}. You'll see the change from that thread's next turn, the same as when ${userName} changes it.`;
}
