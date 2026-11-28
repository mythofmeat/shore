import { InvalidArgs, ToolIoError } from "./errors.ts";
import { ThreadError, type ThreadEdit, type ThreadRecord } from "../engine/threads.ts";
import type { Texts } from "../texts/texts.ts";

export interface EditThreadRequest extends ThreadEdit {
  name: string;
}

function setting(texts: Texts, input: Record<string, unknown>, field: string): string | null | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new InvalidArgs(texts.always("arg_string", { field }));
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function pinList(texts: Texts, input: Record<string, unknown>): string[] | undefined {
  const pins = input["pins"];
  if (pins === undefined || pins === null) return undefined;
  if (!Array.isArray(pins) || !pins.every((pin) => typeof pin === "string")) throw new InvalidArgs(texts.always("threads_pins_form"));
  return pins.map((pin) => pin.trim()).filter((pin) => pin !== "");
}

export function editThreadRequest(texts: Texts, input: Record<string, unknown>): EditThreadRequest {
  const name = typeof input["name"] === "string" ? input["name"].trim() : "";
  if (name === "") throw new InvalidArgs(texts.always("threads_edit_no_name"));
  const label = setting(texts, input, "label");
  const purpose = setting(texts, input, "purpose");
  const pins = pinList(texts, input);
  if (label === undefined && purpose === undefined && pins === undefined) throw new InvalidArgs(texts.always("threads_edit_nothing"));
  return {
    name,
    ...(label === undefined ? {} : { label }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(pins === undefined ? {} : { pins }),
  };
}

function changes(texts: Texts, request: EditThreadRequest, record: ThreadRecord | undefined): string[] {
  return [
    request.label === undefined ? undefined : texts.render("threads_change_label", { label: record?.label }),
    request.purpose === undefined ? undefined : texts.render("threads_change_purpose", { set: record?.purpose === undefined ? undefined : "yes" }),
    request.pins === undefined ? undefined : texts.render("threads_change_pins", { pins: record?.pins?.join(", ") }),
  ].filter((change) => change !== undefined);
}

export async function handleEditThread(
  texts: Texts,
  input: Record<string, unknown>,
  edit: ((request: EditThreadRequest) => Promise<ThreadRecord | undefined>) | undefined,
  userName: string,
): Promise<string> {
  if (edit === undefined) throw new ToolIoError(texts.always("threads_edit_unavailable"));
  const request = editThreadRequest(texts, input);
  let record: ThreadRecord | undefined;
  try {
    record = await edit(request);
  } catch (e) {
    if (!(e instanceof ThreadError)) throw e;
    if (e.kind === "locked") throw new ToolIoError(texts.always("threads_locked", { user: userName, name: request.name }));
    throw new ToolIoError(e.message);
  }
  return texts.render("threads_changed", { name: request.name, changes: changes(texts, request, record).join("; "), user: userName }) ?? "";
}
