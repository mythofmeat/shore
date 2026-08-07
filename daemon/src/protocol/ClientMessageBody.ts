import type { ImageUpload } from "./ImageUpload";
import type { MessageOverrides } from "./MessageOverrides";

export type ClientMessageBody = { rid?: string | null, text: string, stream: boolean, 
images: Array<string>, 
image_data?: Array<ImageUpload>, absence_seconds?: number, overrides?: MessageOverrides | null, };
