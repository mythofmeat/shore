import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { contractValidator } from "./validation.ts";
import type { OperationInput, OperationName, OperationResult } from "./types.ts";
import { internalError, invalidRequest } from "../commands/errors.ts";
import schemas from "./schemas.generated.json" with { type: "json" };

export type { OperationInput, OperationName, OperationResult } from "./types.ts";

let validator: ReturnType<typeof contractValidator> | undefined;

const contracts = new Map<string, { schemas: typeof schemas[number]; input?: ValidateFunction; output?: ValidateFunction }>();
for (const schema of schemas) {
  if (contracts.has(schema.name)) throw new Error(`Duplicate operation contract: ${schema.name}`);
  contracts.set(schema.name, { schemas: schema });
}

function check(name: string, kind: "input" | "output"): ValidateFunction {
  const contract = contracts.get(name);
  if (contract === undefined) throw new Error(`Missing operation contract: ${name}`);
  return contract[kind] ??= (validator ??= contractValidator()).compile(contract.schemas[kind]);
}

export function operationSchema(name: OperationName): typeof schemas[number] {
  const contract = contracts.get(name);
  if (contract === undefined) throw new Error(`Missing generated operation schema: ${name}`);
  return contract.schemas;
}

function violation(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => {
    if (error.keyword === "required") return `Missing required argument: ${String(error.params["missingProperty"])}`;
    return `${error.instancePath || "arguments"} ${error.message ?? "does not match the contract"}`;
  }).join("; ");
}

export function parseOperationInput<N extends OperationName>(name: N, input: unknown): OperationInput<N> {
  const valid = check(name, "input");
  const value: unknown = input ?? {};
  if (!valid(value)) throw invalidRequest(violation(valid.errors));
  return value as OperationInput<N>;
}

export function parseOperationResult<N extends OperationName>(name: N, result: unknown): OperationResult<N> {
  const valid = check(name, "output");
  if (!valid(result)) throw internalError(`Invalid result for ${name}: ${violation(valid.errors)}`);
  return result as OperationResult<N>;
}

export function assertContractBindings(names: readonly string[]): void {
  const handlers = new Set(names);
  if (handlers.size !== names.length) throw new Error("Duplicate operation handler");
  for (const name of contracts.keys()) {
    if (!handlers.has(name)) throw new Error(`Missing operation handler: ${name}`);
  }
  for (const name of handlers) {
    if (!contracts.has(name)) throw new Error(`Missing operation contract: ${name}`);
  }
}
