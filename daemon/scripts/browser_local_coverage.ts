import * as ts from "typescript/unstable/ast";
import { parseInventorySources } from "./capability_inventory.ts";
import { LOCAL_SHORTCUTS } from "../src/browser/keyboard.ts";
import { TERMINAL_LOCAL_COMMANDS, TERMINAL_SHORTCUTS } from "../src/browser/preferences.generated.ts";

const workflows: Record<string, { fields: Record<string, readonly string[]>; targets: string[]; hooks?: string[] }> = {
  insert: { fields: { home: [], end: [] }, targets: ["focus", "focus_home", "focus_end"] },
  normal: { fields: {}, targets: ["transcript"] },
  scroll: { fields: { direction: ["up", "down", "top", "bottom"], amount: [] }, targets: ["up", "down", "top", "bottom"], hooks: ['binding.args["amount"]', "scrollAmount(args)"] },
  images: { fields: {}, targets: ["images"] }, subagents: { fields: {}, targets: ["activity"] }, editor: { fields: {}, targets: ["editor", "undo", "redo"] },
  image: { fields: { target: [] }, targets: ["attach", "clear_images"], hooks: ["onPaste", "imageUpload(file, data)", "conversationRequest"] },
  cancel: { fields: {}, targets: [], hooks: ["workspace.connection.cancel()"] },
  edit_cancel: { fields: {}, targets: ["edit_cancel"] }, help: { fields: {}, targets: ["help"] },
  palette: { fields: { scope: ["full", "shortcuts", "config"] }, targets: ["palette", "quick", "settings"] },
  output: { fields: {}, targets: ["output"], hooks: ["actions.getOutput", "actions.subscribeOutput"] },
  bind: { fields: { key: [], command: [], global: [] }, targets: ["keyboard"], hooks: ["binding.key", "binding.target", "binding.scope", "store.put(binding)"] },
  unbind: { fields: { key: [], global: [] }, targets: ["keyboard"], hooks: ["store.remove(item)", "bindingId(item)"] },
  quit: { fields: {}, targets: ["sign_out"] },
};

export async function localWorkflowReaders(texts: string[]): Promise<{ handlers: Set<string>; hooks: Set<string> }> {
  const handlers = new Set<string>(); const hooks = new Set<string>();
  for (const source of await parseInventorySources(texts, "tsx")) {
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "localShortcuts" && node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) if (ts.isPropertyAssignment(property) && ts.isArrowFunction(property.initializer)) {
          let calls = 0;
          const count = (child: ts.Node) => { if (ts.isCallExpression(child)) calls += 1; child.forEachChild(count); };
          count(property.initializer);
          if (calls > 0) handlers.add(property.name.getText(source));
        }
      }
      if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) hooks.add(node.getText(source));
      if (ts.isJsxAttribute(node)) hooks.add(node.name.getText(source));
      node.forEachChild(visit);
    };
    visit(source);
  }
  return { handlers, hooks };
}

export function assertLocalWorkflowCoverage(readers: { handlers: ReadonlySet<string>; hooks: ReadonlySet<string> }, inventory: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = TERMINAL_LOCAL_COMMANDS): void {
  for (const [command, fields] of Object.entries(inventory)) {
    const workflow = workflows[command];
    if (workflow === undefined) throw new Error(`Missing GUI local workflow: ${command}`);
    if (Object.keys(fields).sort().join() !== Object.keys(workflow.fields).sort().join()) throw new Error(`Missing GUI local fields: ${command}`);
    for (const [field, choices] of Object.entries(fields)) if (JSON.stringify(choices) !== JSON.stringify(workflow.fields[field])) throw new Error(`Missing GUI local choices: ${command}.${field}`);
    for (const target of workflow.targets) if (!Object.hasOwn(LOCAL_SHORTCUTS, target) || !readers.handlers.has(target)) throw new Error(`Missing GUI local handler: ${command}:${target}`);
    for (const hook of workflow.hooks ?? []) if (!readers.hooks.has(hook)) throw new Error(`Missing GUI local reader: ${command}:${hook}`);
  }
}

export function assertQuickActions(names: ReadonlySet<string>): void {
  for (const [name, command] of TERMINAL_SHORTCUTS) {
    if ((command !== name && command !== `msg ${name}`) || !names.has(name)) throw new Error(`Missing GUI conversation shortcut: ${name} (${command})`);
  }
}
