import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { openRegularFile } from "./file_access.ts";
import { IMAGE_EXTENSIONS } from "./read_image.ts";

interface NamedFile {
  path: string;
  folders: string[];
  file: string;
  text?: Promise<boolean>;
}

export interface WorkspaceNames {
  root: string;
  files: NamedFile[];
  folders: NamedFile[];
  byName: Map<string, NamedFile[]>;
  byStem: Map<string, NamedFile[]>;
  byFolder: Map<string, NamedFile[]>;
}

interface Link {
  anchored: boolean;
  folder: boolean;
  folders: string[];
  name: string;
}

export interface Found {
  path: string;
  link: string;
}

const MAX_SUGGESTIONS = 5;

const TEXT_PROBE_BYTES = 8192;

const isPicture = (file: string) => IMAGE_EXTENSIONS.has(extname(file).toLowerCase());

const isNote = (file: string) => file.endsWith(".md");

const stem = (file: string) => file.slice(0, file.length - extname(file).length);

export async function workspaceNames(root: string, signal?: AbortSignal): Promise<WorkspaceNames> {
  const files: NamedFile[] = [];
  const subfolders: NamedFile[] = [];
  const pending: string[][] = [[]];
  for (let folders = pending.pop(); folders !== undefined; folders = pending.pop()) {
    signal?.throwIfAborted();
    const entries = await readdir(join(root, ...folders), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const named = { path: [...folders, entry.name].join("/"), folders, file: entry.name };
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        subfolders.push(named);
        pending.push([...folders, entry.name]);
      } else if (entry.isFile() && !(isNote(entry.name) && named.path.split("/").some((part) => part.startsWith(".")))) {
        files.push(named);
      }
    }
  }
  for (const named of [files, subfolders]) named.sort((a, b) => a.path < b.path ? -1 : 1);
  return {
    root,
    files,
    folders: subfolders,
    byName: Map.groupBy(files, (file) => file.file),
    byStem: Map.groupBy(files, (file) => stem(file.file)),
    byFolder: Map.groupBy(subfolders, (folder) => folder.file),
  };
}

async function probedText(path: string): Promise<boolean> {
  const file = await openRegularFile(path).catch(() => undefined);
  if (file === undefined) return false;
  try {
    const head = Buffer.alloc(TEXT_PROBE_BYTES);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    return !head.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

function isText(names: WorkspaceNames, file: NamedFile): Promise<boolean> {
  return file.text ??= isPicture(file.file) ? Promise.resolve(false) : probedText(join(names.root, file.path));
}

function parseLink(text: string): Link | undefined {
  const target = text.split(/[|#]/, 1)[0]?.trim() ?? "";
  const anchored = target.startsWith("/");
  const folder = target.endsWith("/");
  const folders = target.split("/").filter((part) => part !== "");
  const name = folders.pop() ?? "";
  return name === "" ? undefined : { anchored, folder, folders, name };
}

function placed(file: NamedFile, link: Link): boolean {
  const above = file.folders.length - link.folders.length;
  return above >= 0 && (!link.anchored || above === 0) && link.folders.every((folder, index) => file.folders[above + index] === folder);
}

async function fitting(names: WorkspaceNames, link: Link): Promise<NamedFile[]> {
  const named = (by: Map<string, NamedFile[]>) => (by.get(link.name) ?? []).filter((file) => placed(file, link));
  if (link.folder) return named(names.byFolder);
  const whole = named(names.byName);
  const fits = whole.length > 0 ? whole : named(names.byStem);
  if (fits.length < 2) return fits;
  const texts: NamedFile[] = [];
  for (const file of fits) if (await isText(names, file)) texts.push(file);
  return texts.length > 0 ? texts : fits;
}

function render(link: Link, embed: boolean): string {
  return `${embed ? "!" : ""}[[${link.anchored ? "/" : ""}${[...link.folders, link.name].join("/")}${link.folder ? "/" : ""}]]`;
}

function spellings(file: NamedFile, folder: boolean): Link[] {
  const spelled = !folder && isNote(file.file) ? [stem(file.file), file.file] : [file.file];
  return spelled.flatMap((name) => [
    ...file.folders.map((_, depth) => ({ anchored: false, folder, folders: file.folders.slice(file.folders.length - depth), name })),
    { anchored: false, folder, folders: file.folders, name },
    { anchored: true, folder, folders: file.folders, name },
  ]);
}

async function linkTo(names: WorkspaceNames, file: NamedFile, folder: boolean, embed: boolean): Promise<string> {
  for (const link of spellings(file, folder)) {
    const found = await fitting(names, link);
    if (found.length === 1 && found[0] === file) return render(link, embed);
  }
  return render({ anchored: true, folder, folders: file.folders, name: file.file }, embed);
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

async function suggestions(names: WorkspaceNames, links: readonly Link[], embed: boolean): Promise<string[]> {
  const sought = (links[0]?.name ?? "").toLowerCase();
  const reach = Math.max(1, Math.floor(sought.length / 3));
  const files = embed ? names.files.filter((file) => isPicture(file.file)) : links.some((link) => !link.folder) ? names.files : [];
  const close = [
    ...files.map((file) => ({ file, folder: false, distance: Math.min(editDistance(sought, file.file.toLowerCase()), editDistance(sought, stem(file.file).toLowerCase())) })),
    ...(embed ? [] : names.folders).map((file) => ({ file, folder: true, distance: editDistance(sought, file.file.toLowerCase()) })),
  ]
    .filter(({ distance }) => distance <= reach)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_SUGGESTIONS);
  return await Promise.all(close.map(({ file, folder }) => linkTo(names, file, folder, embed)));
}

async function lookUp(names: WorkspaceNames, links: readonly Link[], embed: boolean, maxListed: number): Promise<{ file: NamedFile; link: Link }> {
  for (const link of links) {
    const found = await fitting(names, link);
    const [only] = found;
    if (only !== undefined && found.length === 1) return { file: only, link };
    if (found.length > 1) {
      const shown = await Promise.all(found.slice(0, maxListed).map((file) => linkTo(names, file, link.folder, embed)));
      const more = found.length > shown.length ? ` and ${String(found.length - shown.length)} more` : "";
      throw new Error(`${String(found.length)} ${link.folder ? "folders" : "files"} match: ${shown.join(", ")}${more}`);
    }
  }
  const missed = `no ${links.map((link) => link.folder ? "folder" : "file").join(" or ")} matches`;
  const close = await suggestions(names, links, embed);
  throw new Error(close.length > 0 ? `${missed}; did you mean ${close.join(", ")}?` : missed);
}

async function notAPicture(names: WorkspaceNames, file: NamedFile, link: Link): Promise<Error> {
  const kind = link.folder ? `${file.path}/ is a folder, not a picture` : `${file.path} is not a picture`;
  const pictures = (names.byStem.get(link.folder ? file.file : stem(file.file)) ?? []).filter((other) => isPicture(other.file) && placed(other, link));
  const [only] = pictures;
  return new Error(only !== undefined && pictures.length === 1 ? `${kind}; did you mean ${await linkTo(names, only, false, true)}?` : kind);
}

export async function embeddedPicture(names: WorkspaceNames, text: string, maxListed: number): Promise<string | undefined> {
  const link = parseLink(text);
  if (link === undefined) return undefined;
  const { file } = await lookUp(names, [link], true, maxListed);
  if (link.folder || !isPicture(file.file)) throw await notAPicture(names, file, link);
  return join(names.root, file.path);
}

export async function linkedFile(names: WorkspaceNames, embed: boolean, text: string): Promise<string> {
  const link = parseLink(text);
  if (link === undefined) throw new Error("the link names no file");
  return join(names.root, (await lookUp(names, [link], embed, Number.POSITIVE_INFINITY)).file.path);
}

export async function namedFile(names: WorkspaceNames, parts: readonly string[], findFolders = true): Promise<Found> {
  const link: Link = { anchored: false, folder: false, folders: parts.slice(0, -1), name: parts.at(-1) ?? "" };
  try {
    const found = await lookUp(names, findFolders ? [link, { ...link, folder: true }] : [link], false, Number.POSITIVE_INFINITY);
    return { path: join(names.root, found.file.path), link: await linkTo(names, found.file, found.link.folder, false) };
  } catch (error) {
    throw new Error(`tried as ${render(link, false)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
