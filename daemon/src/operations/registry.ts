import type { OperationInput, OperationName, OperationResult } from "./contracts.ts";
import { assertContractBindings, operationSchema, parseOperationInput, parseOperationResult } from "./contracts.ts";

export interface FieldPresentation {
  label: string;
  hint?: string;
  choices?: "characters" | "threads" | "models";
  multiline?: boolean;
}

export interface OperationPresentation<N extends OperationName> {
  label: string;
  category: "Characters" | "Threads";
  scope: "global" | "selection" | "character";
  prerequisites: readonly ("threads")[];
  effects: readonly ("read" | "workspace_write" | "history_write" | "selection" | "model_selection")[];
  confirmation: "none" | "archive";
  fields: { [K in keyof OperationInput<N>]-?: FieldPresentation };
}

export interface OperationRegistration<C, N extends OperationName> {
  readonly name: N;
  readonly presentation: OperationPresentation<N>;
  invoke(context: C, rawInput: unknown): OperationResult<N> | Promise<OperationResult<N>>;
}

export type OperationRegistry<C> = { [N in OperationName]: OperationRegistration<C, N> };

export function defineOperation<C, N extends OperationName>(
  name: N,
  presentation: OperationPresentation<N>,
  handler: (context: C, input: OperationInput<N>) => OperationResult<N> | Promise<OperationResult<N>>,
): OperationRegistration<C, N> {
  return {
    name,
    presentation,
    invoke(context, rawInput) {
      const input = parseOperationInput(name, rawInput);
      const result = handler(context, input);
      return result instanceof Promise
        ? result.then((data) => parseOperationResult(name, data))
        : parseOperationResult(name, result);
    },
  };
}

export function discoverOperations<C>(registry: OperationRegistry<C>) {
  assertContractBindings(Object.keys(registry));
  return Object.values<OperationRegistration<C, OperationName>>(registry).map(({ name, presentation }) => {
    const schema = operationSchema(name);
    const fields = "properties" in schema.input ? Object.keys(schema.input.properties ?? {}).sort() : [];
    if (JSON.stringify(fields) !== JSON.stringify(Object.keys(presentation.fields).sort())) {
      throw new Error(`Unaccounted operation fields: ${name}`);
    }
    return { name, ...presentation, input: schema.input, output: schema.output };
  });
}
