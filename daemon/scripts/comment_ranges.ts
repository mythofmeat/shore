import {
  LanguageVariant,
  SyntaxKind,
  computeLineStarts,
  createScanner,
  isTriviaKind,
} from "typescript/unstable/ast";

export interface CommentRange {
  pos: number;
  end: number;
}

const ENDS_A_VALUE = new Set<SyntaxKind>([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

export function commentRanges(text: string): CommentRange[] {
  const scanner = createScanner(false, LanguageVariant.Standard, text);
  const found: CommentRange[] = [];
  const substitutionDepths: number[] = [];
  let braceDepth = 0;
  let previous: SyntaxKind = SyntaxKind.Unknown;

  for (;;) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) break;
    if (scanner.getTokenEnd() === scanner.getTokenStart()) {
      scanner.resetTokenState(scanner.getTokenEnd() + 1);
      continue;
    }

    if (isTriviaKind(kind)) {
      if (kind === SyntaxKind.SingleLineCommentTrivia || kind === SyntaxKind.MultiLineCommentTrivia) {
        found.push({ pos: scanner.getTokenStart(), end: scanner.getTokenEnd() });
      }
      continue;
    }

    if (
      (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
      !ENDS_A_VALUE.has(previous)
    ) {
      kind = scanner.reScanSlashToken();
    }

    if (kind === SyntaxKind.CloseBraceToken) {
      const innermost = substitutionDepths.length - 1;
      if (innermost >= 0 && substitutionDepths[innermost] === braceDepth) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) substitutionDepths.pop();
      } else {
        braceDepth -= 1;
      }
    } else if (kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    }

    if (kind === SyntaxKind.TemplateHead) substitutionDepths.push(braceDepth);

    previous = kind;
  }

  return found;
}

export function lineNumberAt(lineStarts: readonly number[], pos: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    const start = lineStarts[mid];
    if (start !== undefined && start <= pos) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

export function lineStartsOf(text: string): number[] {
  return computeLineStarts(text);
}
