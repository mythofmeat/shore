import type { CharacterAvatar } from "../../protocol/CharacterAvatar.ts";
import { Icon } from "./icons.tsx";

export const AVATAR_TONES = 6;

export function avatarTone(name: string): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return hash % AVATAR_TONES;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function initial(name: string): string {
  for (const { segment } of graphemes.segment(name.trim())) return segment.toLocaleUpperCase();
  return "?";
}

export function Avatar({ name, avatar, size = 36, selected = false }: { name: string; avatar?: CharacterAvatar | null | undefined; size?: number; selected?: boolean }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (avatar !== undefined && avatar !== null) return <img className={`avatar ${selected ? "selected" : ""}`} style={style} src={`data:${avatar.mime_type};base64,${avatar.data}`} alt="" />;
  return <span className={`avatar ${selected ? "selected" : ""}`} data-tone={avatarTone(name)} style={style} aria-hidden="true">{initial(name)}</span>;
}

export function UserAvatar({ size = 36 }: { size?: number }) {
  return <span className="avatar user" style={{ width: size, height: size }} aria-hidden="true"><Icon name="person" size={Math.round(size / 2)} /></span>;
}
