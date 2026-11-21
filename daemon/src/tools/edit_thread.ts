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

function pinList(input: Record<string, unknown>): string[] | undefined {
  const pins = input["pins"];
  if (pins === undefined || pins === null) return undefined;
  if (!Array.isArray(pins) || !pins.every((pin) => typeof pin === "string")) {
    throw new InvalidArgs("pins must be a list of workspace paths and !commands");
  }
  return pins.map((pin) => pin.trim()).filter((pin) => pin !== "");
}

export function editThreadRequest(input: Record<string, unknown>): EditThreadRequest {
  const name = typeof input["name"] === "string" ? input["name"].trim() : "";
  if (name === "") throw new InvalidArgs("name is required: the id of the thread to change");
  const label = setting(input, "label");
  const purpose = setting(input, "purpose");
  const pins = pinList(input);
  if (label === undefined && purpose === undefined && pins === undefined) {
    throw new InvalidArgs("give at least one of label, purpose or pins to change");
  }
  return {
    name,
    ...(label === undefined ? {} : { label }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(pins === undefined ? {} : { pins }),
  };
}

function changes(request: EditThreadRequest, record: ThreadRecord | undefined): string[] {
  return [
    ...(request.label === undefined ? [] : [record?.label === undefined ? "label cleared" : `label "${record.label}"`]),
    ...(request.purpose === undefined ? [] : [record?.purpose === undefined ? "purpose cleared" : "purpose set"]),
    ...(request.pins === undefined ? [] : [record?.pins === undefined ? "pins cleared" : `pins ${record.pins.join(", ")}`]),
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
        `Nothing changed: ${userName} locked the thread "${request.name}", so its label, purpose and pins change only when ${userName} changes them.`,
      );
    }
    throw new ToolIoError(e.message);
  }
  return `Changed the thread "${request.name}": ${changes(request, record).join("; ")}. You'll see the change from that thread's next turn, the same as when ${userName} changes it.`;
}
