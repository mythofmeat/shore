import type { ContentBlock } from "./ContentBlock";
import type { ImageRef } from "./ImageRef";

export type MessageAlternative = { content: string, images: Array<ImageRef>, content_blocks: Array<ContentBlock>, timestamp: string, 
provider_key?: string | null, 
model?: string | null, };
