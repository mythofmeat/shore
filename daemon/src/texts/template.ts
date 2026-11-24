type Piece =
  | { kind: "text"; text: string }
  | { kind: "value"; name: string; tag: string }
  | { kind: "if"; name: string; yes: Piece[]; no: Piece[] };

const TAG = /\{\{([^{}]*)\}\}/g;

function ifName(inner: string): string | undefined {
  return inner.startsWith("#if ") ? inner.slice("#if ".length).trim() : undefined;
}

function parse(template: string): Piece[] {
  const root: Piece[] = [];
  const open: { piece: Extract<Piece, { kind: "if" }>; tag: string; before: Piece[]; elseTag?: string }[] = [];
  let into = root;
  let cursor = 0;
  const text = (value: string): void => {
    if (value !== "") into.push({ kind: "text", text: value });
  };
  for (const match of template.matchAll(TAG)) {
    const [raw, inner = ""] = match;
    text(template.slice(cursor, match.index));
    cursor = match.index + raw.length;
    const name = ifName(inner);
    const block = open.at(-1);
    if (name !== undefined) {
      const piece: Extract<Piece, { kind: "if" }> = { kind: "if", name, yes: [], no: [] };
      open.push({ piece, tag: raw, before: into });
      into = piece.yes;
    } else if (inner === "else" && block !== undefined && block.elseTag === undefined) {
      block.elseTag = raw;
      into = block.piece.no;
    } else if (inner === "/if" && block !== undefined) {
      open.pop();
      into = block.before;
      into.push(block.piece);
    } else {
      into.push({ kind: "value", name: inner, tag: raw });
    }
  }
  text(template.slice(cursor));
  for (let block = open.pop(); block !== undefined; block = open.pop()) {
    into = block.before;
    into.push({ kind: "text", text: block.tag }, ...block.piece.yes, ...(block.elseTag === undefined ? [] : [{ kind: "text" as const, text: block.elseTag }]), ...block.piece.no);
  }
  return root;
}

function render(pieces: readonly Piece[], vars: ReadonlyMap<string, string>): string {
  return pieces.map((piece) => {
    if (piece.kind === "text") return piece.text;
    if (piece.kind === "value") return vars.get(piece.name) ?? piece.tag;
    const value = vars.get(piece.name);
    return render(value !== undefined && value !== "" ? piece.yes : piece.no, vars);
  }).join("");
}

export function renderTemplate(template: string, vars: ReadonlyMap<string, string>): string {
  return render(parse(template), vars);
}
