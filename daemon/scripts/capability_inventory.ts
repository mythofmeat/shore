import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";

import { commandCatalogue } from "../src/commands/registry.ts";

const ROOT = join(import.meta.dir, "..");
export const INVENTORY_PATH = join(ROOT, "../docs/capabilities/daemon.generated.json");

export async function parseInventorySources(texts: readonly string[], extension: "ts" | "tsx" = "ts"): Promise<ts.SourceFile[]> {
  const base = "/__shore_inventory__";
  const paths = texts.map((_text, index) => `${base}/${String(index)}.${extension}`);
  const files = Object.fromEntries(paths.map((path, index) => [path, texts[index] ?? ""]));
  files[`${base}/tsconfig.json`] = JSON.stringify({ files: paths, compilerOptions: { noLib: true, noResolve: true } });
  const api = new API({ cwd: base, fs: createVirtualFileSystem(files) });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [`${base}/tsconfig.json`] });
    try {
      const project = snapshot.getProject(`${base}/tsconfig.json`);
      if (project === undefined) throw new Error("TypeScript did not load the inventory project");
      const sources: ts.SourceFile[] = [];
      for (const path of paths) {
        const source = await project.program.getSourceFile(path);
        if (source === undefined) throw new Error(`TypeScript did not parse ${path}`);
        sources.push(source);
      }
      return sources;
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
}

function visit(node: ts.Node, accept: (node: ts.Node) => void): void {
  accept(node);
  node.forEachChild((child) => visit(child, accept));
}

export function dispatchInventory(source: ts.SourceFile): Record<string, string[]> {
  const operations: Record<string, string[]> = {};
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
    const runner = statement.name.text;
    if (runner !== "runCommand" && runner !== "runCharacterlessCommand") continue;
    visit(statement, (node) => {
      if (!ts.isSwitchStatement(node) || node.expression.getText(source) !== "cmd.name") return;
      for (const branch of node.caseBlock.clauses) {
        if (!ts.isCaseClause(branch) || !ts.isStringLiteral(branch.expression)) continue;
        const name = branch.expression.text;
        (operations[name] ??= []).push(runner);
      }
    });
  }
  return Object.fromEntries(Object.entries(operations).sort(([a], [b]) => a.localeCompare(b)));
}

export function protocolInventory(sources: readonly ts.SourceFile[]): Record<string, string> {
  const definitions: Record<string, string> = {};
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!ts.isTypeAliasDeclaration(statement)) continue;
      definitions[statement.name.text] = statement.type.getText(source).trim();
    }
  }
  return Object.fromEntries(Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)));
}

export async function currentDaemonInventory(): Promise<object> {
  const protocolDir = join(ROOT, "src/protocol");
  const [dispatch, ...protocol] = await parseInventorySources([
    readFileSync(join(ROOT, "src/commands/dispatch.ts"), "utf8"),
    ...readdirSync(protocolDir).filter((name) => name.endsWith(".ts")).sort().map((name) => readFileSync(join(protocolDir, name), "utf8")),
  ]);
  if (dispatch === undefined) throw new Error("Missing parsed dispatcher");
  const legacy = dispatchInventory(dispatch);
  const operations = { ...legacy };
  for (const operation of commandCatalogue()) {
    if (Object.hasOwn(legacy, operation.name)) throw new Error(`Operation still has a legacy dispatch path: ${operation.name}`);
    operations[operation.name] = ["registry", `scope:${operation.scope}`];
  }
  return {
    format: 1,
    operations: Object.fromEntries(Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))),
    legacy_operations: Object.keys(legacy),
    protocol: protocolInventory(protocol),
  };
}

export function assertInventoryCurrent(expected: object, actual: object): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Daemon capabilities changed; run bun run inventory:generate and review the operation, field, result, and event differences");
  }
}

if (import.meta.main) {
  const current = await currentDaemonInventory();
  if (process.argv.includes("--write")) {
    writeFileSync(INVENTORY_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log("Generated daemon operation and wire inventory");
  } else {
    assertInventoryCurrent(JSON.parse(readFileSync(INVENTORY_PATH, "utf8")) as object, current);
    console.log("Daemon operation and wire inventory is current");
  }
}
