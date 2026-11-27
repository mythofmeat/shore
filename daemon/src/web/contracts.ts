import type { ValidateFunction } from "ajv/dist/2020.js";
import { contractValidator } from "../operations/validation.ts";
import type { WebLogin } from "../protocol/WebLogin.ts";
import type { WebLoginCode } from "../protocol/WebLoginCode.ts";
import type { WebSessionInfo } from "../protocol/WebSessionInfo.ts";
import type { WebProblem } from "../protocol/WebProblem.ts";
import type { WebArchiveExport } from "../protocol/WebArchiveExport.ts";
import type { WebArchiveInfo } from "../protocol/WebArchiveInfo.ts";
import type { WebArchiveList } from "../protocol/WebArchiveList.ts";
import type { WebRequestInfo } from "../protocol/WebRequestInfo.ts";
import type { WebRequestList } from "../protocol/WebRequestList.ts";
import type { WebPreferences } from "../protocol/WebPreferences.ts";
import type { WebAutomationKey } from "../protocol/WebAutomationKey.ts";
import type { WebDeviceChoice } from "../protocol/WebDeviceChoice.ts";
import type { WebDeviceList } from "../protocol/WebDeviceList.ts";
import type { WebNewDevice } from "../protocol/WebNewDevice.ts";
import type { WebSignInDecision } from "../protocol/WebSignInDecision.ts";
import type { WebSignInGranted } from "../protocol/WebSignInGranted.ts";
import type { WebSignInPending } from "../protocol/WebSignInPending.ts";
import type { WebSignInPoll } from "../protocol/WebSignInPoll.ts";
import type { WebSignInStart } from "../protocol/WebSignInStart.ts";
import schemas from "./schemas.generated.json" with { type: "json" };

let validator: ReturnType<typeof contractValidator> | undefined;

function onFirstUse<T>(schema: object): (value: unknown) => value is T {
  let valid: ValidateFunction<T> | undefined;
  return (value: unknown): value is T => (valid ??= (validator ??= contractValidator()).compile<T>(schema))(value);
}

export const validWebLogin = onFirstUse<WebLogin>(schemas.login);
export const validWebSession = onFirstUse<WebSessionInfo>(schemas.session);
export const validWebLoginCode = onFirstUse<WebLoginCode>(schemas.login_code);
export const validWebProblem = onFirstUse<WebProblem>(schemas.problem);
export const validWebArchiveExport = onFirstUse<WebArchiveExport>(schemas.archive_export);
export const validWebArchiveInfo = onFirstUse<WebArchiveInfo>(schemas.archive_info);
export const validWebArchiveList = onFirstUse<WebArchiveList>(schemas.archive_list);
export const validWebRequestInfo = onFirstUse<WebRequestInfo>(schemas.request_info);
export const validWebRequestList = onFirstUse<WebRequestList>(schemas.request_list);
export const validWebPreferences = onFirstUse<WebPreferences>(schemas.preferences);
export const validWebDeviceList = onFirstUse<WebDeviceList>(schemas.device_list);
export const validWebAutomationKey = onFirstUse<WebAutomationKey>(schemas.automation_key);
export const validWebNewDevice = onFirstUse<WebNewDevice>(schemas.new_device);
export const validWebDeviceChoice = onFirstUse<WebDeviceChoice>(schemas.device_choice);
export const validWebSignInStart = onFirstUse<WebSignInStart>(schemas.sign_in_start);
export const validWebSignInPending = onFirstUse<WebSignInPending>(schemas.sign_in_pending);
export const validWebSignInPoll = onFirstUse<WebSignInPoll>(schemas.sign_in_poll);
export const validWebSignInGranted = onFirstUse<WebSignInGranted>(schemas.sign_in_granted);
export const validWebSignInDecision = onFirstUse<WebSignInDecision>(schemas.sign_in_decision);
