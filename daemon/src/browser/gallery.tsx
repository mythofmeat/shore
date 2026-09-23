import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./components.tsx";
import { mediaSource, imageFilename, type GalleryImage } from "./media.ts";

export function Gallery({ images, opened, mediaLimited = false, earlier, canLoadEarlier, close }: { images: GalleryImage[]; mediaLimited?: boolean; opened?: { source: string; caption: string }; earlier: () => Promise<void>; canLoadEarlier: boolean; close: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { container.current?.focus(); }, []);
  const matching = useMemo(() => opened === undefined ? undefined : images.find((item) => item.caption === opened.caption && mediaSource(item.data, item.mime) === opened.source) ?? images.find((item) => mediaSource(item.data, item.mime) === opened.source), [images, opened]);
  const [standalone] = useState(() => opened !== undefined && matching === undefined);
  const entries = standalone && opened !== undefined ? [{ id: "opened", caption: opened.caption, data: opened.source.slice(opened.source.indexOf(",") + 1), mime: opened.source.slice(5, opened.source.indexOf(";")) }] : images;
  const [selected, setSelected] = useState(() => matching ?? entries[0]);
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedIndex = entries.findIndex((item) => item.id === selected?.id);
  const position = Math.max(0, selectedIndex >= 0 ? selectedIndex : entries.findIndex((item) => item.data === selected?.data && item.caption === selected?.caption));
  const current = entries[position];
  const source = current === undefined ? undefined : mediaSource(current.data, current.mime);
  const move = (next: number) => setSelected(entries[Math.max(0, Math.min(entries.length - 1, next))]);
  return <Modal title="Image" close={close}><div className="gallery" ref={container} tabIndex={-1} onKeyDown={(event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowLeft": event.preventDefault(); move(position - 1); break;
      case "ArrowRight": event.preventDefault(); move(position + 1); break;
      case "Home": event.preventDefault(); move(0); break;
      case "End": event.preventDefault(); move(entries.length - 1); break;
    }
  }}>
    {mediaLimited ? <p className="notice">Some live images were released to limit memory.</p> : null}
    <div className="actions"><button aria-label="Previous image" disabled={position === 0} onClick={() => move(position - 1)}>Previous</button><p role="status">{entries.length === 0 ? "No images loaded" : `${String(position + 1)} of ${String(entries.length)}`}</p><button aria-label="Next image" disabled={position >= entries.length - 1} onClick={() => move(position + 1)}>Next</button></div>
    {current === undefined ? <p>Images from loaded conversation history and live responses appear here.</p> : <figure><figcaption aria-label="Image caption">{current.caption}</figcaption>{source === undefined ? <p>Image data is unavailable.</p> : <><img key={current.id} className="full-image" alt={current.caption} src={source} onLoad={() => setFailed(undefined)} onError={() => setFailed(current.id)} />{failed === current.id ? <p role="alert">This image could not be decoded.</p> : null}<a href={source} download={imageFilename(current.caption, source)}>Download image</a></>}</figure>}
    <p className="muted">Use Left/Right to browse, Home/End for the first/last loaded image, and Escape to close.</p>
    {standalone || !canLoadEarlier ? null : <button disabled={busy} onClick={() => { setBusy(true); setError(""); void earlier().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setBusy(false)); }}>{busy ? "Loading…" : "Load earlier history"}</button>}
    {error === "" ? null : <p role="alert">{error}</p>}
  </div></Modal>;
}
