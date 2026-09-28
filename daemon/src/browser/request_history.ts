import type { WebRequestList } from "../protocol/WebRequestList.ts";
import { validWebRequestList } from "./validators.generated.js";

export async function requestHistory(path: string): Promise<Response> {
  const response = await fetch(`/api/requests${path}`, { method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Couldn’t load request history. Try again after reconnecting.");
  return response;
}

export async function listRequests(): Promise<WebRequestList> {
  const value: unknown = await (await requestHistory("/list")).json();
  if (!validWebRequestList(value)) throw new Error("The daemon sent an unexpected request history. Reload the page.");
  return value;
}
