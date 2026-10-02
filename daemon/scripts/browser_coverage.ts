import * as ts from "typescript/unstable/ast";
import type { Control } from "../src/browser/forms.ts";
import { actionControl } from "../src/browser/forms.ts";
import { EVENT_POLICIES } from "../src/browser/workspace.ts";
import type { OperationDescriptor } from "../src/protocol/OperationDescriptor.ts";
import wire from "../src/protocol/wire.generated.json" with { type: "json" };
import { parseInventorySources } from "./capability_inventory.ts";
import terminal from "../src/browser/terminal_capabilities.generated.json" with { type: "json" };

export function assertDisplayCoverage(choices: Readonly<Record<string, readonly string[]>>, controls: Readonly<Record<string, unknown>>, modes: Readonly<Record<string, ReadonlySet<string>>>): void {
  for (const preference of terminal.view_preferences) {
    const key = preference.key;
    if (JSON.stringify(choices[key]) !== JSON.stringify(preference.values)) throw new Error(`Missing GUI display choices: ${key}`);
    if (controls[key] === undefined) throw new Error(`Missing GUI display control: ${key}`);
    if (!preference.values.includes("on")) for (const value of preference.values) {
      if (value !== "toggle" && !modes[key]?.has(value)) throw new Error(`Missing GUI display mode: ${key}:${value}`);
    }
  }
}

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

function assertControls(operation: OperationDescriptor, renderers: ReadonlySet<string>): void {
  const check = (control: Control): void => {
    if (!renderers.has(control.kind)) throw new Error(`Missing GUI control renderer: ${control.kind}`);
    if (control.kind === "array") check(control.item);
    if (control.kind === "union") control.options.forEach(check);
    if (control.kind === "object") { Object.values(control.fields).forEach(check); if (control.additional !== undefined) check(control.additional); }
  };
  check(actionControl(operation));
}

export function assertBrowserCoverage(operations: OperationDescriptor[], renderers: ReadonlySet<string>, events: ReadonlySet<string>, policies: Readonly<Record<string, string>> = EVENT_POLICIES): void {
  for (const operation of operations) assertControls(operation, renderers);
  for (const variant of wire.server.oneOf) {
    const name = variant.properties.type.const;
    if (!events.has(name) || policies[name] === undefined) throw new Error(`Missing GUI event handling: ${name}`);
  }
}
