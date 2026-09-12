import { contractValidator } from "../operations/validation.ts";
import type { WebLogin } from "../protocol/WebLogin.ts";
import type { WebSessionInfo } from "../protocol/WebSessionInfo.ts";
import type { WebProblem } from "../protocol/WebProblem.ts";
import schemas from "./schemas.generated.json" with { type: "json" };

const validator = contractValidator();
export const validWebLogin = validator.compile<WebLogin>(schemas.login);
export const validWebSession = validator.compile<WebSessionInfo>(schemas.session);
export const validWebProblem = validator.compile<WebProblem>(schemas.problem);
