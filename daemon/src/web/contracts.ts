import type { ValidateFunction } from "ajv/dist/2020.js";
import { contractValidator } from "../operations/validation.ts";
import type { WebLogin } from "../protocol/WebLogin.ts";
import type { WebSessionInfo } from "../protocol/WebSessionInfo.ts";
import type { WebProblem } from "../protocol/WebProblem.ts";
import type { WebArchiveExport } from "../protocol/WebArchiveExport.ts";
import type { WebArchiveInfo } from "../protocol/WebArchiveInfo.ts";
import type { WebArchiveList } from "../protocol/WebArchiveList.ts";
import type { WebRequestInfo } from "../protocol/WebRequestInfo.ts";
import type { WebRequestList } from "../protocol/WebRequestList.ts";
import schemas from "./schemas.generated.json" with { type: "json" };

let validator: ReturnType<typeof contractValidator> | undefined;

function onFirstUse<T>(schema: object): (value: unknown) => value is T {
  let valid: ValidateFunction<T> | undefined;
  return (value: unknown): value is T => (valid ??= (validator ??= contractValidator()).compile<T>(schema))(value);
}

export const validWebLogin = onFirstUse<WebLogin>(schemas.login);
export const validWebSession = onFirstUse<WebSessionInfo>(schemas.session);
export const validWebProblem = onFirstUse<WebProblem>(schemas.problem);
export const validWebArchiveExport = onFirstUse<WebArchiveExport>(schemas.archive_export);
export const validWebArchiveInfo = onFirstUse<WebArchiveInfo>(schemas.archive_info);
export const validWebArchiveList = onFirstUse<WebArchiveList>(schemas.archive_list);
export const validWebRequestInfo = onFirstUse<WebRequestInfo>(schemas.request_info);
export const validWebRequestList = onFirstUse<WebRequestList>(schemas.request_list);
