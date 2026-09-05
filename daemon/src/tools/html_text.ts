import { required } from "../util/required.ts";

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name] ?? entity;
    const hex = name[1]?.toLowerCase() === "x";
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF)
      ? String.fromCodePoint(code) : "�";
  });
}

export function htmlToText(html: string, baseUrl?: string): string {
  const preformatted: { marker: string; text: string }[] = [];
  const lists: { next: number; ordered: boolean }[] = [];
  const blocks = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "blockquote", "dl", "dt", "dd", "table"]);
  const rewriter = new HTMLRewriter()
    .on("script, style, head, template, noscript, [hidden], [aria-hidden='true']", {
      element(element) { element.remove(); },
    })
    .on("pre", {
      element(element) {
        const marker = `SHORE_PRE_${crypto.randomUUID()}`;
        preformatted.push({ marker, text: "" });
        element.replace(`\n\n${marker}\n\n`);
      },
      text(chunk) { required(preformatted.at(-1)).text += chunk.text; },
    })
    .on("*", {
      element(element) {
        const tag = element.tagName;
        if (tag === "pre") return;
        if (/^h[1-6]$/.test(tag)) {
          element.before(`\n\n${"#".repeat(Number(tag[1]))} `);
          element.after("\n\n");
        } else if (blocks.has(tag)) {
          element.before("\n\n");
          element.after("\n\n");
        } else if (tag === "br" || tag === "tr") {
          element.before("\n");
        } else if (tag === "td" || tag === "th") {
          element.after(" | ");
        } else if (tag === "ol" || tag === "ul") {
          element.before("\n");
          element.after("\n");
          const start = Number.parseInt(element.getAttribute("start") ?? "1", 10);
          lists.push({ next: Number.isFinite(start) ? start : 1, ordered: tag === "ol" });
          element.onEndTag(() => { lists.pop(); });
        } else if (tag === "li") {
          const list = lists.at(-1);
          const prefix = list?.ordered ? `${list.next++}. ` : "- ";
          element.before(`\n${prefix}`);
        } else if (tag === "a") {
          const href = element.getAttribute("href");
          if (href) {
            try {
              const url = new URL(decodeEntities(href), baseUrl);
              if (["http:", "https:", "mailto:"].includes(url.protocol)) element.after(` (${url.href})`);
            } catch {
              if (baseUrl === undefined && !href.includes(":")) element.after(` (${decodeEntities(href)})`);
            }
          }
        } else if (tag === "img") {
          const alt = element.getAttribute("alt");
          if (alt) element.before(`[Image: ${decodeEntities(alt)}]`);
        }
        element.removeAndKeepContent();
      },
    })
    .onDocument({
      doctype(doctype) { doctype.remove(); },
      comments(comment) { comment.remove(); },
      text(chunk) { chunk.replace(chunk.text.replace(/\p{White_Space}+/gu, " "), { html: true }); },
    });
  let text = decodeEntities(rewriter.transform(html))
    .split("\n").map((line) => line.replace(/[^\S\n]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  for (const block of preformatted) {
    const code = decodeEntities(block.text).replace(/^\n|\n$/g, "");
    const runs = code.match(/`+/g) ?? [];
    const fence = "`".repeat(runs.reduce((longest, run) => Math.max(longest, run.length + 1), 3));
    text = text.replace(block.marker, () => `${fence}\n${code}\n${fence}`);
  }
  return text;
}
