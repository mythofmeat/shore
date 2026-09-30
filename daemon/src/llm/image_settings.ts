export type ImageFormat = "keep" | "jpeg" | "webp" | "png";

export const IMAGE_FORMATS: readonly ImageFormat[] = ["keep", "jpeg", "webp", "png"];

export interface ImageSettings {
  max_tokens: number;
  max_edge: number;
  format: ImageFormat;
  quality: number;
  png_compression: number;
  png_palette: boolean;
  max_bytes: number;
}

export const DEFAULT_IMAGE_SETTINGS: Readonly<ImageSettings> = Object.freeze({
  max_tokens: 0,
  max_edge: 2000,
  format: "keep",
  quality: 85,
  png_compression: 6,
  png_palette: false,
  max_bytes: 750_000,
});

export const API_MAX_IMAGE_EDGE = 8000;

export const MANY_IMAGES = 20;

export const MANY_IMAGES_MAX_EDGE = 2000;

export const MAX_SENT_IMAGE_BYTES = 3_750_000;
