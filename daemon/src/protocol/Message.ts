import type { ContentBlock } from "./ContentBlock";
import type { ImageRef } from "./ImageRef";
import type { MessageAlternative } from "./MessageAlternative";
import type { MessageOrigin } from "./MessageOrigin";
import type { Role } from "./Role";

export type Message = { msg_id: string, role: Role, content: string, images: Array<ImageRef>, content_blocks: Array<ContentBlock>, alt_index?: number | null, alt_count?: number | null, alternatives?: Array<MessageAlternative>, timestamp: string, 
provider_key?: string | null, 
model?: string | null, 
origin?: MessageOrigin | null, };
