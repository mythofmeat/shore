import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..");
const SCANNED = ["src", "tests"];

const COUPLING =
  /\b(must change together|change together|must agree|must both|the two must|both exist|while both|in both directions|closes? in both|stays? in sync|kept in sync|keep(?:s|ing)? (?:them|the two|both) in sync|neither half can move)\b/i;

const CITATION = /`([^`\s]*\/[^`\s]*)`|\b((?:crates|src|tests|client|daemon|prompts|scripts)\/[\w./-]+)/g;

const TENSE_EXEMPT =
  /\b(was|were|existed|used to|no longer|deleted|gone|used|has been|had been|since removed)\b/i;

interface Offence {
  file: string;
  line: number;
  path: string;
  excerpt: string;
}

function commentRanges(sf: ts.SourceFile, text: string): ts.CommentRange[] {
  const byPos = new Map<number, ts.CommentRange>();
  const add = (rs: ts.CommentRange[] | undefined) => {
    for (const r of rs ?? []) byPos.set(r.pos, r);
  };
  const walk = (node: ts.Node) => {
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      add(ts.getLeadingCommentRanges(text, node.getFullStart()));
      add(ts.getTrailingCommentRanges(text, node.getEnd()));
      return;
    }
    for (const k of kids) walk(k);
  };
  walk(sf);
  return [...byPos.values()].sort((a, b) => a.pos - b.pos);
}

function sentences(comment: string): string[] {
  return comment
    .replace(/^\s*(\/\*+|\*+\/|\/\/)/gm, "")
    .replace(/^\s*\*/gm, "")
    .split(/(?<=[.:;])\s+|\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");
}

function citedPaths(sentence: string): string[] {
  const found: string[] = [];
  for (const m of sentence.matchAll(CITATION)) {
    const raw = m[1] ?? m[2];
    if (raw !== undefined) found.push(raw);
  }
  return found;
}

function resolves(cited: string): boolean {
  const bare = cited.replace(/::.*$/, "").replace(/[.,)]+$/, "");
  return (
    existsSync(join(REPO, bare)) ||
    existsSync(join(ROOT, bare)) ||
    existsSync(join(REPO, "daemon", bare))
  );
}

const offences: Offence[] = [];
let scanned = 0;

for (const dir of SCANNED) {
  const base = join(ROOT, dir);
  for (const rel of new Glob("**/*.ts").scanSync(base)) {
    const abs = join(base, rel);
    const text = readFileSync(abs, "utf8");
    scanned += 1;
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);

    for (const range of commentRanges(sf, text)) {
      const comment = text.slice(range.pos, range.end);
      for (const sentence of sentences(comment)) {
        if (!COUPLING.test(sentence)) continue;
        if (TENSE_EXEMPT.test(sentence)) continue;
        for (const cited of citedPaths(sentence)) {
          if (resolves(cited)) continue;
          offences.push({
            file: relative(REPO, abs),
            line: sf.getLineAndCharacterOfPosition(range.pos).line + 1,
            path: cited,
            excerpt: sentence.slice(0, 140),
          });
        }
      }
    }
  }
}

if (offences.length > 0) {
  console.error(
    `${offences.length} comment(s) claim a live coupling with a path that does not exist:\n`,
  );
  for (const o of offences) {
    console.error(`  ${o.file}:${o.line}`);
    console.error(`    cites: ${o.path}`);
    console.error(`    says:  ${o.excerpt}\n`);
  }
  console.error(
    "A comment may record where code came from — that is history, and correct.\n" +
      "It may not say two things change together when one of them is gone.\n" +
      "Rewrite the claim in the past tense, or drop the citation.",
  );
  process.exit(1);
}

console.log(`no stale coupling claims in ${scanned} files`);
