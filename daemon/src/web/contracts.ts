import { contractValidator } from "../operations/validation.ts";
import type { WebLogin } from "../protocol/WebLogin.ts";
import type { WebSessionInfo } from "../protocol/WebSessionInfo.ts";
import type { WebProblem } from "../protocol/WebProblem.ts";
import type { WebArchiveExport } from "../protocol/WebArchiveExport.ts";
import type { WebArchiveInfo } from "../protocol/WebArchiveInfo.ts";
import type { WebArchiveList } from "../protocol/WebArchiveList.ts";
import schemas from "./schemas.generated.json" with { type: "json" };

const validator = contractValidator();
export const validWebLogin = validator.compile<WebLogin>(schemas.login);
export const validWebSession = validator.compile<WebSessionInfo>(schemas.session);
export const validWebProblem = validator.compile<WebProblem>(schemas.problem);
export const validWebArchiveExport = validator.compile<WebArchiveExport>(schemas.archive_export);
export const validWebArchiveInfo = validator.compile<WebArchiveInfo>(schemas.archive_info);
export const validWebArchiveList = validator.compile<WebArchiveList>(schemas.archive_list);
