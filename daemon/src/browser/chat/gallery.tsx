import { useMemo, useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { conversationImages, imageFilename, mediaSource } from "../media.ts";
import { FullPicture } from "../pictures.tsx";
import { Dialog, Spinner } from "../ui/controls.tsx";
import { perform, workspace } from "../app/state.ts";
import { segmentName } from "./transcript.ts";

export function GalleryDialog({ state, close }: { state: WorkspaceSnapshot; close: () => void }) {
  const view = state.segmentView;
  const images = useMemo(() => (view === null ? conversationImages(state.messages, state.streams, state.media) : conversationImages(view.messages, [], [])).flatMap((image) => {
    const source = mediaSource(image.data, image.mime);
    return source === undefined ? [] : [{ ...image, source }];
  }), [view, state.messages, state.streams, state.media]);
  const [open, setOpen] = useState<number>();
  const [loading, setLoading] = useState(false);
  const selected = open === undefined ? undefined : images[open];
  return <Dialog title={selected === undefined ? view === null ? "Images in the current context" : `Images in ${segmentName(view.segment)}` : selected.caption} close={() => { if (selected === undefined) close(); else setOpen(undefined); }} wide>
    {selected === undefined ? <>
      {images.length === 0 ? <p className="form-text">{view === null ? "No images in the current context." : "No images in the loaded part of this segment."}</p> : <div className="gallery-grid">
        {images.map((image, index) => <button key={image.id} type="button" className="image-thumb" aria-label={`Open ${image.caption}`} onClick={() => setOpen(index)}><img src={image.source} alt={image.caption} loading="lazy" /></button>)}
      </div>}
      {view?.hasEarlier === true ? <div className="form-actions">{loading ? <Spinner label="Loading earlier messages" /> : <button type="button" className="button" onClick={() => { setLoading(true); perform(async () => { try { await workspace.loadEarlierInSegment(); } finally { setLoading(false); } }); }}>Load images from earlier in this segment</button>}</div> : null}
    </> : <>
      <FullPicture key={selected.id} source={selected.full ?? selected.source} caption={selected.caption} />
      <div className="dialog-footer">
        <button type="button" className="button" disabled={open === 0} onClick={() => setOpen((open ?? 1) - 1)}>Previous</button>
        <button type="button" className="button" disabled={open === images.length - 1} onClick={() => setOpen((open ?? 0) + 1)}>Next</button>
        <a className="button" href={selected.full ?? selected.source} download={imageFilename(selected.caption, selected.full ?? selected.source)}>Download</a>
        <button type="button" className="button" onClick={() => setOpen(undefined)}>All images</button>
      </div>
    </>}
  </Dialog>;
}
