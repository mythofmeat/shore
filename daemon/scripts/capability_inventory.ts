import { requestCatalogue } from "../src/operations/requests.ts";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";

import { commandCatalogue } from "../src/commands/registry.ts";

const ROOT = join(import.meta.dir, "..");
export const INVENTORY_PATH = join(ROOT, "src/web/capabilities.generated.json");

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

export function assertRegisteredDispatch(source: ts.SourceFile): void {
  const legacy = Object.keys(dispatchInventory(source));
  if (legacy.length > 0) throw new Error(`Unregistered production dispatch paths: ${legacy.join(", ")}`);
}

export function registryInventory(source: ts.SourceFile, binding = "commandOperations"): string[] {
  const names: string[] = [];
  visit(source, (node) => {
    if (!ts.isVariableDeclaration(node) || node.name.getText(source) !== binding || node.initializer === undefined) return;
    const initializer = ts.isSatisfiesExpression(node.initializer) ? node.initializer.expression : node.initializer;
    if (!ts.isObjectLiteralExpression(initializer)) return;
    for (const property of initializer.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isCallExpression(property.initializer) || property.initializer.expression.getText(source) !== "register") throw new Error("Every command handler must use register");
      const name = property.initializer.arguments[0];
      if (name === undefined || !ts.isStringLiteral(name) || property.name.getText(source) !== name.text) throw new Error("Registration key must match its canonical operation");
      names.push(name.text);
    }
  });
  if (names.length === 0) throw new Error("Missing executable operation registry");
  return names.sort();
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
  const [dispatch, registry, requests, ...protocol] = await parseInventorySources([
    readFileSync(join(ROOT, "src/commands/dispatch.ts"), "utf8"),
    readFileSync(join(ROOT, "src/commands/registry.ts"), "utf8"),
    readFileSync(join(ROOT, "src/operations/requests.ts"), "utf8"),
    ...readdirSync(protocolDir).filter((name) => name.endsWith(".ts")).sort().map((name) => readFileSync(join(protocolDir, name), "utf8")),
  ]);
  if (dispatch === undefined) throw new Error("Missing parsed dispatcher");
  if (registry === undefined) throw new Error("Missing parsed operation registry");
  if (requests === undefined) throw new Error("Missing parsed core request registry");
  assertInventoryCurrent(registryInventory(requests, "coreRequests"), requestCatalogue().map((request) => request.name).sort());
  assertRegisteredDispatch(dispatch);
  assertInventoryCurrent(registryInventory(registry), commandCatalogue().map((operation) => operation.name).sort());
  const operations: Record<string, string[]> = {};
  for (const operation of commandCatalogue()) {
    operations[operation.name] = ["registry", `scope:${operation.scope}`];
  }
  return {
    format: 1,
    operations: Object.fromEntries(Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))),
    requests: requestCatalogue().map((request) => ({ name: request.name, input: request.input, output: request.output })),
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
