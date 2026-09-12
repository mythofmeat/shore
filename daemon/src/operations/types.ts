import type { OperationRequest } from "../protocol/OperationRequest.ts";
import type { OperationResponse } from "../protocol/OperationResponse.ts";

export type OperationName = OperationRequest["name"];
type Inputs = { [Request in OperationRequest as Request["name"]]: Request["args"] };
type Results = { [Response in OperationResponse as Response["name"]]: Response["data"] };
export type OperationInput<N extends OperationName> = Inputs[N];
export type OperationResult<N extends OperationName> = Results[N];
