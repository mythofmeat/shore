import * as ts from "typescript/unstable/ast";
import type { Control } from "../src/browser/forms.ts";
import { actionControl } from "../src/browser/forms.ts";
import { EVENT_POLICIES } from "../src/browser/workspace.ts";
import type { OperationDescriptor } from "../src/protocol/OperationDescriptor.ts";
import wire from "../src/protocol/wire.generated.json" with { type: "json" };
import operationSchemas from "../src/operations/schemas.generated.json" with { type: "json" };
import webSchemas from "../src/web/schemas.generated.json" with { type: "json" };
import { parseInventorySources } from "./capability_inventory.ts";

export async function switchCases(text: string, functionName: string, expression: string): Promise<Set<string>> {
  const source = (await parseInventorySources([text], "tsx")).at(0);
  if (source === undefined) throw new Error("Missing browser syntax tree");
  const cases = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isSwitchStatement(node) && node.expression.getText(source) === expression) {
      for (const branch of node.caseBlock.clauses) if (ts.isCaseClause(branch) && ts.isStringLiteral(branch.expression)) cases.add(branch.expression.text);
    }
    node.forEachChild(collect);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(source) === functionName) collect(node);
    else node.forEachChild(visit);
  };
  visit(source);
  return cases;
}

export function assertCompactionResultCoverage(renderers: ReadonlySet<string>): void {
  const schema = operationSchemas.find((operation) => operation.name === "compact")?.output;
  if (schema === undefined || !("oneOf" in schema) || schema.oneOf === undefined) throw new Error("Missing compaction result contract");
  for (const variant of schema.oneOf) {
    if (!("status" in variant.properties)) throw new Error("Missing compaction status discriminator");
    const status = variant.properties.status.const;
    if (!renderers.has(status)) throw new Error(`Missing compaction result renderer: ${status}`);
  }
}

export function assertUsageResultCoverage(renderers: ReadonlySet<string>): void {
  const schema = operationSchemas.find((operation) => operation.name === "usage")?.output;
  if (schema === undefined || !("oneOf" in schema) || schema.oneOf === undefined) throw new Error("Missing usage result contract");
  for (const variant of schema.oneOf) {
    if (!("mode" in variant.properties)) throw new Error("Missing usage mode discriminator");
    const mode = variant.properties.mode.const;
    if (!renderers.has(mode)) throw new Error(`Missing usage result renderer: ${mode}`);
  }
}

export function assertArchivePhaseCoverage(renderers: ReadonlySet<string>): void {
  for (const phase of webSchemas.archive_info.$defs.WebArchivePhase.enum) {
    if (!renderers.has(phase)) throw new Error(`Missing archive phase renderer: ${phase}`);
  }
}

export function assertBrowserCoverage(operations: OperationDescriptor[], renderers: ReadonlySet<string>, events: ReadonlySet<string>, policies: Readonly<Record<string, string>> = EVENT_POLICIES): void {
  const check = (control: Control): void => {
    if (!renderers.has(control.kind)) throw new Error(`Missing GUI control renderer: ${control.kind}`);
    if (control.kind === "array") check(control.item);
    if (control.kind === "union") control.options.forEach(check);
    if (control.kind === "object") { Object.values(control.fields).forEach(check); if (control.additional !== undefined) check(control.additional); }
  };
  for (const operation of operations) check(actionControl(operation));
  for (const variant of wire.server.oneOf) {
    const name = variant.properties.type.const;
    if (!events.has(name) || policies[name] === undefined) throw new Error(`Missing GUI event handling: ${name}`);
  }
}
