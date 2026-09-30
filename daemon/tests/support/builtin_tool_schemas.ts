import { ALL_TOOLS } from "../../src/tools/registry.ts";
import { schemasFrom } from "../../src/tools/validate.ts";

export const BUILTIN_TOOL_SCHEMAS = schemasFrom(
  ALL_TOOLS.map((tool) => ({ name: tool.name, input_schema: tool.parameters })),
);
