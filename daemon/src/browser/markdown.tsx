import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Parents, RootContent } from "mdast";
import { memo, useRef, type ReactNode } from "react";
import { imageEmbed, splitText } from "../engine/embeds.ts";
import { EmbeddedPicture } from "./pictures.tsx";

const SAFE_LINK = /^(https?:|mailto:)/i;

export function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  return SAFE_LINK.test(trimmed) ? trimmed : undefined;
}

function children(node: Parents, prefix: string, source: string): ReactNode[] {
  return node.children.map((child, index) => render(child, `${prefix}.${String(index)}`, source));
}

function textWithPictures(value: string, key: string, raw: string | undefined): ReactNode {
  if (raw === undefined || !value.includes("![[")) return value;
  const parts = splitText(value, raw);
  return parts.length === 1 && typeof parts[0] === "string" ? value : <span key={key}>{parts.map((part, index) => typeof part === "string" ? part : <EmbeddedPicture key={index} embed={part} />)}</span>;
}

function render(node: RootContent, key: string, source: string): ReactNode {
  switch (node.type) {
    case "paragraph": return <p key={key}>{children(node, key, source)}</p>;
    case "heading": {
      const Tag = (`h${String(Math.min(node.depth + 2, 6))}`) as "h3" | "h4" | "h5" | "h6";
      return <Tag key={key}>{children(node, key, source)}</Tag>;
    }
    case "text": return textWithPictures(node.value, key, node.position?.start.offset === undefined || node.position.end.offset === undefined ? undefined : source.slice(node.position.start.offset, node.position.end.offset));
    case "emphasis": return <em key={key}>{children(node, key, source)}</em>;
    case "strong": return <strong key={key}>{children(node, key, source)}</strong>;
    case "delete": return <del key={key}>{children(node, key, source)}</del>;
    case "inlineCode": return <code key={key}>{node.value}</code>;
    case "code": return <pre key={key}><code data-language={node.lang ?? undefined}>{node.value}</code></pre>;
    case "blockquote": return <blockquote key={key}>{children(node, key, source)}</blockquote>;
    case "list": return node.ordered === true
      ? <ol key={key} start={node.start ?? undefined}>{children(node, key, source)}</ol>
      : <ul key={key}>{children(node, key, source)}</ul>;
    case "listItem": return <li key={key}>{node.spread === true ? children(node, key, source) : node.children.flatMap((child, index) => child.type === "paragraph" ? children(child, `${key}.${String(index)}`, source) : [render(child, `${key}.${String(index)}`, source)])}</li>;
    case "thematicBreak": return <hr key={key} />;
    case "break": return <br key={key} />;
    case "link": {
      const href = safeHref(node.url);
      return href === undefined ? <span key={key}>{children(node, key, source)}</span> : <a key={key} href={href} target="_blank" rel="noopener noreferrer">{children(node, key, source)}</a>;
    }
    case "image": {
      const embed = imageEmbed(source, node);
      if (embed !== undefined) return <EmbeddedPicture key={key} embed={embed} />;
      const href = safeHref(node.url);
      const label = node.alt === null || node.alt === undefined || node.alt === "" ? node.url : node.alt;
      return href === undefined ? <span key={key}>{label}</span> : <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
    }
    case "html": return node.value;
    case "linkReference": case "imageReference": case "definition": case "footnoteReference": case "footnoteDefinition":
    case "table": case "tableRow": case "tableCell": case "yaml":
      return "children" in node ? <span key={key}>{children(node, key, source)}</span> : null;
  }
}

export interface SettledMarkdown { text: string; blocks: ReactNode[] }

const UNSETTLED: SettledMarkdown = { text: "", blocks: [] };

function defines(node: Nodes): boolean {
  return node.type === "definition" || ("children" in node && node.children.some(defines));
}

export function markdownBlocks(text: string, previous: SettledMarkdown = UNSETTLED): { blocks: ReactNode[]; settled: SettledMarkdown } {
  const base = text.startsWith(previous.text) ? previous : UNSETTLED;
  const tail = text.slice(base.text.length);
  const tree = fromMarkdown(tail);
  const defined = defines(tree);
  if (defined && base !== UNSETTLED) return markdownBlocks(text);
  const blocks = [...base.blocks, ...tree.children.map((child, index) => render(child, `m.${String(base.blocks.length + index)}`, tail))];
  const complete = tail.lastIndexOf("\n");
  const open = tree.children.findLastIndex((child) => (child.position?.start.offset ?? Infinity) <= complete);
  const start = defined || open < 1 ? undefined : tree.children[open]?.position?.start.offset;
  if (start === undefined) return { blocks, settled: base };
  const cut = tail.lastIndexOf("\n", start - 1) + 1;
  return { blocks, settled: { text: base.text + tail.slice(0, cut), blocks: blocks.slice(0, base.blocks.length + open) } };
}

export const Markdown = memo(function Markdown({ text, className = "prose" }: { text: string; className?: string }) {
  const settled = useRef<SettledMarkdown>(UNSETTLED);
  let blocks: ReactNode[];
  try { ({ blocks, settled: settled.current } = markdownBlocks(text, settled.current)); } catch { return <div className={className}><p>{text}</p></div>; }
  return <div className={className}>{blocks}</div>;
});
