import { expect, test } from "bun:test";
import { imageFilename, mediaSource } from "../src/browser/media.ts";

const png = "iVBORw0K";

test("image sources allow raster data only and download names cannot escape their filename", () => {
  expect(mediaSource(png)).toBe(`data:image/png;base64,${png}`);
  expect(mediaSource("/9j/AA==")).toBe("data:image/jpeg;base64,/9j/AA==");
  expect(mediaSource("R0lGODAA")).toContain("image/gif");
  expect(mediaSource("UklGR123")).toContain("image/webp");
  for (const data of [null, undefined, "", "<script>", "https://host/image.png"]) expect(mediaSource(data)).toBeUndefined();
  for (const mime of ["image/svg+xml", "text/html", "image/png;url=evil"]) expect(mediaSource(png, mime)).toBeUndefined();
  expect(imageFilename("../private\\secret\u0000.svg", `data:image/png;base64,${png}`)).toBe(".._private_secret_.svg.png");
  expect(imageFilename("photo.jpg", "data:image/jpeg;base64,/9j/")).toBe("photo.jpg");
  expect(imageFilename("", "data:image/webp;base64,UklGR")).toBe("shore-image.webp");
  expect(imageFilename("a".repeat(1000), `data:image/png;base64,${png}`).length).toBe(184);
});
