import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Parents } from "mdast";
import type { ReactNode } from "react";

const SAFE_LINK = /^(https?:|mailto:)/i;

export function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  return SAFE_LINK.test(trimmed) ? trimmed : undefined;
}

function children(node: Parents, prefix: string): ReactNode[] {
  return node.children.map((child, index) => render(child, `${prefix}.${String(index)}`));
}

function render(node: Nodes, key: string): ReactNode {
  switch (node.type) {
    case "root": return <>{children(node, key)}</>;
    case "paragraph": return <p key={key}>{children(node, key)}</p>;
    case "heading": {
      const Tag = (`h${String(Math.min(node.depth + 2, 6))}`) as "h3" | "h4" | "h5" | "h6";
      return <Tag key={key}>{children(node, key)}</Tag>;
    }
    case "text": return node.value;
    case "emphasis": return <em key={key}>{children(node, key)}</em>;
    case "strong": return <strong key={key}>{children(node, key)}</strong>;
    case "delete": return <del key={key}>{children(node, key)}</del>;
    case "inlineCode": return <code key={key}>{node.value}</code>;
    case "code": return <pre key={key}><code data-language={node.lang ?? undefined}>{node.value}</code></pre>;
    case "blockquote": return <blockquote key={key}>{children(node, key)}</blockquote>;
    case "list": return node.ordered === true
      ? <ol key={key} start={node.start ?? undefined}>{children(node, key)}</ol>
      : <ul key={key}>{children(node, key)}</ul>;
    case "listItem": return <li key={key}>{node.spread === true ? children(node, key) : node.children.flatMap((child, index) => child.type === "paragraph" ? children(child, `${key}.${String(index)}`) : [render(child, `${key}.${String(index)}`)])}</li>;
    case "thematicBreak": return <hr key={key} />;
    case "break": return <br key={key} />;
    case "link": {
      const href = safeHref(node.url);
      return href === undefined ? <span key={key}>{children(node, key)}</span> : <a key={key} href={href} target="_blank" rel="noopener noreferrer">{children(node, key)}</a>;
    }
    case "image": {
      const href = safeHref(node.url);
      const label = node.alt === null || node.alt === undefined || node.alt === "" ? node.url : node.alt;
      return href === undefined ? <span key={key}>{label}</span> : <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
    }
    case "html": return node.value;
    case "linkReference": case "imageReference": case "definition": case "footnoteReference": case "footnoteDefinition":
    case "table": case "tableRow": case "tableCell": case "yaml":
      return "children" in node ? <span key={key}>{children(node, key)}</span> : null;
  }
}

export function Markdown({ text, className = "prose" }: { text: string; className?: string }) {
  let tree: Nodes;
  try { tree = fromMarkdown(text); } catch { return <div className={className}><p>{text}</p></div>; }
  return <div className={className}>{render(tree, "m")}</div>;
}
