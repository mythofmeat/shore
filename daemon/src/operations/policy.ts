import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";

export function operationPolicy(operation: OperationDescriptor, input: Readonly<Record<string, unknown>>): Pick<OperationDescriptor, "effects" | "confirmation"> {
  const match = operation.policies?.find(({ condition }) => condition.kind === "absent"
    ? !Object.hasOwn(input, condition.field)
    : Object.hasOwn(input, condition.field) && input[condition.field] === condition.value);
  return match ?? operation;
}

export function changesState(operation: OperationDescriptor, input: Readonly<Record<string, unknown>>): boolean {
  return operationPolicy(operation, input).effects.some((effect) => effect !== "read" && effect !== "selection");
}
