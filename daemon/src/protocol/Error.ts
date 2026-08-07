import type { ErrorCode } from "./ErrorCode";

export type Error = { rid?: string | null, code: ErrorCode, message: string, };
