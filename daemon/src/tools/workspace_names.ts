import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { IMAGE_EXTENSIONS } from "./read_image.ts";

export type NameKind = "note" | "picture";

interface NamedFile {
  path: string;
  folders: string[];
  file: string;
}

export interface WorkspaceNames {
  root: string;
  note: NamedFile[];
  picture: NamedFile[];
  capitals: NamedFile[];
}

interface Link {
  anchored: boolean;
  folders: string[];
  name: string;
}

export interface Found {
  path: string;
  link: string;
}

const MAX_SUGGESTIONS = 5;

const isPicture = (file: string) => IMAGE_EXTENSIONS.has(extname(file).toLowerCase());

const noteName = (name: string) => name.endsWith(".md") ? name.slice(0, -3) : name;

const allCaps = (name: string) => name !== name.toLowerCase() && name === name.toUpperCase();

export async function workspaceNames(root: string, signal?: AbortSignal): Promise<WorkspaceNames> {
  const names: WorkspaceNames = { root, note: [], picture: [], capitals: [] };
  const pending: string[][] = [[]];
  for (let folders = pending.pop(); folders !== undefined; folders = pending.pop()) {
    signal?.throwIfAborted();
    const entries = await readdir(join(root, ...folders), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const named = { path: [...folders, entry.name].join("/"), folders, file: entry.name };
      if (entry.isDirectory() && entry.name !== ".git") pending.push([...folders, entry.name]);
      else if (!entry.isFile()) continue;
      else if (isPicture(entry.name)) names.picture.push(named);
      else if (entry.name.endsWith(".md") && !named.path.split("/").some((part) => part.startsWith("."))) {
        (allCaps(noteName(entry.name)) ? names.capitals : names.note).push(named);
      }
    }
  }
  for (const files of [names.note, names.picture, names.capitals]) files.sort((a, b) => a.path < b.path ? -1 : 1);
  return names;
}

function parseLink(text: string): Link | undefined {
  const target = text.split(/[|#]/, 1)[0]?.trim() ?? "";
  const anchored = target.startsWith("/");
  const folders = (anchored ? target.slice(1) : target).split("/");
  const name = folders.pop() ?? "";
  return name === "" ? undefined : { anchored, folders, name };
}

function wanted(link: Link, kind: NameKind): string {
  return kind === "note" ? noteName(link.name) : link.name;
}

function nameOf(file: NamedFile, link: Link, kind: NameKind): string {
  if (kind === "note") return noteName(file.file);
  return isPicture(link.name) ? file.file : file.file.slice(0, -extname(file.file).length);
}

function placed(file: NamedFile, link: Link): boolean {
  const above = file.folders.length - link.folders.length;
  return above >= 0 && (!link.anchored || above === 0) && link.folders.every((folder, index) => file.folders[above + index] === folder);
}

function matching(files: readonly NamedFile[], link: Link, kind: NameKind): NamedFile[] {
  return files.filter((file) => placed(file, link) && nameOf(file, link, kind) === wanted(link, kind));
}

function render(link: Link, kind: NameKind): string {
  return `${kind === "picture" ? "!" : ""}[[${link.anchored ? "/" : ""}${[...link.folders, link.name].join("/")}]]`;
}

function linkTo(names: WorkspaceNames, file: NamedFile, kind: NameKind): string {
  const name = kind === "note" ? noteName(file.file) : file.file;
  for (let depth = 0; depth <= file.folders.length; depth += 1) {
    const link = { anchored: false, folders: file.folders.slice(file.folders.length - depth), name };
    if (matching(names[kind], link, kind).length === 1) return render(link, kind);
  }
  return render({ anchored: true, folders: file.folders, name }, kind);
}

function editDistance(a: string, b: string): number {
  const right = Array.from(b);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [row, char] of Array.from(a).entries()) {
    const current = [row + 1];
    for (const [column, other] of right.entries()) {
      current.push(Math.min((previous[column + 1] ?? 0) + 1, (current[column] ?? 0) + 1, (previous[column] ?? 0) + (char === other ? 0 : 1)));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function suggestions(names: WorkspaceNames, link: Link, kinds: readonly NameKind[]): string[] {
  return kinds.flatMap((kind) => {
    const sought = wanted(link, kind).toLowerCase();
    const reach = Math.max(1, Math.floor(sought.length / 3));
    return names[kind]
      .map((file) => ({ file, kind, distance: editDistance(sought, nameOf(file, link, kind).toLowerCase()) }))
      .filter(({ distance }) => distance <= reach);
  })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ file, kind }) => linkTo(names, file, kind));
}

function listed(items: readonly string[], max: number): string {
  return items.length > max ? `${items.slice(0, max).join(", ")} and ${String(items.length - max)} more` : items.join(", ");
}

function lookUp(names: WorkspaceNames, link: Link, kinds: readonly NameKind[], maxListed: number): Found {
  for (const kind of kinds) {
    const found = matching(names[kind], link, kind);
    const [only] = found;
    if (only !== undefined && found.length === 1) return { path: join(names.root, only.path), link: linkTo(names, only, kind) };
    if (found.length > 1) throw new Error(`${String(found.length)} ${kind}s match: ${listed(found.map((file) => linkTo(names, file, kind)), maxListed)}`);
  }
  const problems = [`no ${kinds.join(" or ")} matches`];
  const capitals = kinds.includes("note") ? matching(names.capitals, link, "note") : [];
  if (capitals.length > 0) problems.push(`all-caps notes are skipped as names, so read ${capitals.length === 1 ? "it" : "one"} by path: ${capitals.map((file) => file.path).join(", ")}`);
  const close = suggestions(names, link, kinds);
  if (close.length > 0) problems.push(`did you mean ${close.join(", ")}?`);
  throw new Error(problems.join("; "));
}

export function embeddedPicture(names: WorkspaceNames, text: string, maxListed: number): string | undefined {
  const link = parseLink(text);
  if (link === undefined || (matching(names.picture, link, "picture").length === 0 && matching(names.note, link, "note").length > 0)) return undefined;
  return lookUp(names, link, ["picture"], maxListed).path;
}

export function linkedFile(names: WorkspaceNames, embed: boolean, text: string): string {
  const link = parseLink(text);
  if (link === undefined) throw new Error("the link names no file");
  const kinds: NameKind[] = embed ? ["picture", "note"] : [isPicture(link.name) ? "picture" : "note"];
  return lookUp(names, link, kinds, Number.POSITIVE_INFINITY).path;
}

export function namedFile(names: WorkspaceNames, parts: readonly string[]): Found {
  const folders = parts.slice(0, -1);
  const name = parts.at(-1) ?? "";
  const link = { anchored: false, folders, name };
  const kind = isPicture(name) ? "picture" : "note";
  try {
    return lookUp(names, link, [kind], Number.POSITIVE_INFINITY);
  } catch (error) {
    throw new Error(`tried as ${render(link, kind)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
