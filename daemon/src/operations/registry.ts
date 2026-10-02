import type { OperationInput, OperationName, OperationResult } from "./contracts.ts";
import { assertContractBindings, operationSchema, parseOperationInput, parseOperationResult } from "./contracts.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { OperationField } from "../protocol/OperationField.ts";
import type { OperationPolicy } from "../protocol/OperationPolicy.ts";

type FieldPresentation = OperationField;

export interface OperationPresentation<N extends OperationName> extends Pick<OperationDescriptor, "label" | "category" | "scope" | "confirmation"> {
  prerequisites: Readonly<OperationDescriptor["prerequisites"]>;
  effects: Readonly<OperationDescriptor["effects"]>;
  fields: { [K in keyof OperationInput<N>]-?: FieldPresentation };
  policies?: readonly OperationPolicy[];
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
    const { policies, ...metadata } = presentation;
    for (const policy of policies ?? []) if (!fields.includes(policy.condition.field)) throw new Error(`Unknown policy field: ${name}.${policy.condition.field}`);
    return { name, ...metadata, ...(policies === undefined ? {} : { policies: [...policies] }), prerequisites: [...presentation.prerequisites], effects: [...presentation.effects], input: schema.input, output: schema.output };
  });
}
