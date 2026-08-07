import type { StreamMetadata } from "./StreamMetadata";

export type StreamEnd = { rid?: string | null, 
msg_id?: string | null, 
revision?: number, content: string, metadata: StreamMetadata, 
finish_reason?: string, 
is_final: boolean, 
subagent?: string | null, };
