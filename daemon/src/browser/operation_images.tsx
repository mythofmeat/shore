import { useState } from "react";
import { ImageView } from "./components.tsx";
import { Gallery } from "./gallery.tsx";
import { validOperationResult } from "./operation_validators.generated.js";

export function OperationImages({ name, result }: { name: string; result: unknown }) {
  const [opened, setOpened] = useState<{ source: string; caption: string }>();
  if (name !== "run_tool" || !validOperationResult("run_tool", result) || "mode" in result || result.images === undefined || result.images.length === 0) return null;
  const images = result.images.map((image, index) => ({ id: `${image.path}:${String(index)}`, caption: image.caption ?? image.path.split(/[\\/]/).at(-1) ?? "Tool image", data: image.data, mime: undefined }));
  return <section aria-label="Tool images"><h4>Images</h4><div className="operation-images">{images.map((image) => <ImageView key={image.id} data={image.data ?? null} caption={image.caption} open={(source, caption) => setOpened({ source, caption: caption ?? image.caption })} />)}</div>
    {opened === undefined ? null : <Gallery images={images} opened={opened} canLoadEarlier={false} earlier={async () => {}} close={() => setOpened(undefined)} />}
  </section>;
}
