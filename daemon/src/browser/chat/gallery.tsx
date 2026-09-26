import { useMemo, useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { conversationImages, imageFilename, mediaSource } from "../media.ts";
import { Dialog, Spinner } from "../ui/controls.tsx";
import { perform, workspace } from "../app/state.ts";

export function GalleryDialog({ state, close }: { state: WorkspaceSnapshot; close: () => void }) {
  const images = useMemo(() => conversationImages(state.messages, state.streams, state.media).flatMap((image) => {
    const source = mediaSource(image.data, image.mime);
    return source === undefined ? [] : [{ ...image, source }];
  }), [state.messages, state.streams, state.media]);
  const [open, setOpen] = useState<number>();
  const [loading, setLoading] = useState(false);
  const selected = open === undefined ? undefined : images[open];
  return <Dialog title={selected === undefined ? "Images in this conversation" : selected.caption} close={() => { if (selected === undefined) close(); else setOpen(undefined); }} wide>
    {selected === undefined ? <>
      {images.length === 0 ? <p className="form-text">No images in the loaded part of this conversation.</p> : <div className="gallery-grid">
        {images.map((image, index) => <button key={image.id} type="button" className="image-thumb" aria-label={`Open ${image.caption}`} onClick={() => setOpen(index)}><img src={image.source} alt={image.caption} loading="lazy" /></button>)}
      </div>}
      {state.hasEarlier ? <div className="form-actions">{loading ? <Spinner label="Loading earlier messages" /> : <button type="button" className="button" onClick={() => { setLoading(true); perform(async () => { try { await workspace.loadEarlier(); } finally { setLoading(false); } }); }}>Load images from earlier messages</button>}</div> : null}
    </> : <>
      <img className="lightbox-image" src={selected.source} alt={selected.caption} />
      <div className="dialog-footer">
        <button type="button" className="button" disabled={open === 0} onClick={() => setOpen((open ?? 1) - 1)}>Previous</button>
        <button type="button" className="button" disabled={open === images.length - 1} onClick={() => setOpen((open ?? 0) + 1)}>Next</button>
        <a className="button" href={selected.source} download={imageFilename(selected.caption, selected.source)}>Download</a>
        <button type="button" className="button" onClick={() => setOpen(undefined)}>All images</button>
      </div>
    </>}
  </Dialog>;
}
