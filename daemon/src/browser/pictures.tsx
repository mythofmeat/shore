import { createContext, useContext, useState, type ReactNode } from "react";
import type { ImageRef } from "../protocol/ImageRef.ts";
import { embedName, embedsIn, sentFor, type Embed } from "../engine/embeds.ts";
import { mediaSource, pictureUrl } from "./media.ts";
import { Icon } from "./ui/icons.tsx";

export type OpenPicture = (source: string, caption: string) => void;

export interface SentPictures {
  images: readonly ImageRef[];
  open: OpenPicture;
  live: boolean;
  shown: boolean;
}

export const Pictures = createContext<SentPictures | null>(null);

export function isSentPicture(image: Pick<ImageRef, "embed" | "problem" | "path">): boolean {
  return typeof image.embed === "string" && (image.problem === undefined || image.problem === null) && image.path !== "";
}

export function pictureCaption(image: Pick<ImageRef, "caption" | "name" | "path">): string {
  return image.caption ?? image.name ?? image.path.split(/[\\/]/).at(-1) ?? "Picture";
}

export function unplacedPictures(images: readonly ImageRef[], texts: readonly string[]): ImageRef[] {
  const placed = new Set(texts.flatMap((text) => embedsIn(text).map((embed) => embed.source)));
  return images.filter((image) => isSentPicture(image) && !placed.has(image.embed ?? ""));
}

export function SentPicture({ image, open }: { image: ImageRef; open: OpenPicture }) {
  const caption = pictureCaption(image);
  const source = mediaSource(image.data);
  return <button type="button" className="picture" onClick={() => open(pictureUrl(image.path), image.name ?? caption)} aria-label={`Open ${caption}`}>
    <img src={source ?? pictureUrl(image.path)} alt={caption} loading="lazy" />
  </button>;
}

export function FullPicture({ source, caption }: { source: string; caption: string }) {
  const [actual, setActual] = useState(false);
  return <div className={`lightbox-frame ${actual ? "actual" : ""}`}>
    <button type="button" className="lightbox-zoom" aria-pressed={actual} aria-label={actual ? "Fit the picture to the window" : "Show the picture at full size"} onClick={() => setActual(!actual)}>
      <img className="lightbox-image" src={source} alt={caption} />
    </button>
  </div>;
}

function NamedPicture({ name, title }: { name: string; title: string }) {
  return <span className="picture-name" title={title}><Icon name="image" size={14} /><span>{name}</span></span>;
}

export function EmbeddedPicture({ embed }: { embed: Embed }): ReactNode {
  const pictures = useContext(Pictures);
  if (pictures === null) return embed.wikilink ? embed.source : embed.label ?? embed.target;
  const image = sentFor(pictures.images, embed);
  const name = embed.label ?? embedName(embed);
  if (image === undefined || !isSentPicture(image)) {
    const why = image?.problem ?? (pictures.live ? "Sending…" : "This picture was not sent");
    return <NamedPicture name={name} title={why} />;
  }
  if (!pictures.shown) return <NamedPicture name={image.name ?? name} title={pictureCaption(image)} />;
  return <SentPicture image={image} open={pictures.open} />;
}
