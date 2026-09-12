import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { contractValidator } from "./validation.ts";
import type { OperationRequest } from "../protocol/OperationRequest.ts";
import type { OperationResponse } from "../protocol/OperationResponse.ts";
import { internalError, invalidRequest } from "../commands/errors.ts";
import schemas from "./schemas.generated.json" with { type: "json" };

export type OperationName = OperationRequest["name"];
type Inputs = { [Request in OperationRequest as Request["name"]]: Request["args"] };
type Results = { [Response in OperationResponse as Response["name"]]: Response["data"] };
export type OperationInput<N extends OperationName> = Inputs[N];
export type OperationResult<N extends OperationName> = Results[N];

const validator = contractValidator();

const contracts = new Map<string, { input: ValidateFunction; output: ValidateFunction; schemas: typeof schemas[number] }>();
for (const schema of schemas) {
  if (contracts.has(schema.name)) throw new Error(`Duplicate operation contract: ${schema.name}`);
  contracts.set(schema.name, { input: validator.compile(schema.input), output: validator.compile(schema.output), schemas: schema });
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
  const contract = contracts.get(name);
  if (contract === undefined) throw new Error(`Missing operation contract: ${name}`);
  const value: unknown = input ?? {};
  if (!contract.input(value)) throw invalidRequest(violation(contract.input.errors));
  return value as OperationInput<N>;
}

export function parseOperationResult<N extends OperationName>(name: N, result: unknown): OperationResult<N> {
  const contract = contracts.get(name);
  if (contract === undefined) throw new Error(`Missing operation contract: ${name}`);
  if (!contract.output(result)) throw internalError(`Invalid result for ${name}: ${violation(contract.output.errors)}`);
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
