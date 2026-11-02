import { DISPLAY_EDGE } from "../storage/sent_pictures.ts";

export const VIDEO_EXTENSIONS = new Set([".mp4", ".webm"]);

export const MEDIA_HEADER_BYTES = 64;

const FRAME_TIMEOUT_MS = 30_000;

const MP4_BRAND = /^(?:iso[m2-9]|mp4[12]|avc1|dash|M4V |mmp4)$/;

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

export function videoMime(header: Buffer): string | undefined {
  if (header.toString("latin1", 4, 8) === "ftyp" && MP4_BRAND.test(header.toString("latin1", 8, 12))) return "video/mp4";
  if (header.subarray(0, 4).equals(EBML_MAGIC) && header.subarray(4, MEDIA_HEADER_BYTES).includes("webm")) return "video/webm";
  return undefined;
}

export async function firstVideoFrame(path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  const fit = `scale=min(${String(DISPLAY_EDGE)}\\,iw):min(${String(DISPLAY_EDGE)}\\,ih):force_original_aspect_ratio=decrease`;
  const command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-vf", fit, "-c:v", "png", "-f", "image2pipe", "-"];
  const stop = AbortSignal.any([AbortSignal.timeout(FRAME_TIMEOUT_MS), ...(signal === undefined ? [] : [signal])]);
  try {
    const ffmpeg = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", signal: stop });
    const [frame, status] = await Promise.all([new Response(ffmpeg.stdout).arrayBuffer(), ffmpeg.exited]);
    return status === 0 && frame.byteLength > 0 ? Buffer.from(frame) : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}
