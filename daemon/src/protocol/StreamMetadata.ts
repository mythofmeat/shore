import type { TimingInfo } from "./TimingInfo";
import type { TokenCounts } from "./TokenCounts";

export type StreamMetadata = { tokens: TokenCounts, timing: TimingInfo, model: string, };
